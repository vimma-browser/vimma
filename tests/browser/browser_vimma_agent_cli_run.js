/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent-cli.md, delivery 2 (C2, C4-C13 for Claude Code). A conversation
// with an agent CLI provider runs the program setup confirmed, with fixed arguments and the task
// on stdin, in an empty private folder that goes with the run; its only MCP server is the real
// vimma-ctl mcp with the run's ticket, so its steps are the conversation's, under its grant, and
// counted by the gate. A stop closes the ticket's connection before the signal. The CLI is
// fake_vimma_agent_cli.py, which speaks Claude Code's stream-json and runs no model.

"use strict";

/* global focusContent -- from head.js */
/* global tidyTask -- from head_vimma_control.js */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { AgentChat } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { AgentCli, CLI_ENABLED_PREF, VIMMA_CTL_PREF, pathPref } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentCli.sys.mjs",
);
const { AgentGate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/AgentGate.sys.mjs",
);
const { VimmaControl, ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { McpHost, MCP_ENABLED_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/mcp-ops.mjs",
);
const { AGENT_DEFAULTS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/config.mjs",
);
const { providerKey } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-setup.mjs",
);
const { claudeArguments } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-cli.mjs",
);
const { chatHeader, sendNotice: windowNotice } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-chat.mjs",
);
const { ConfigHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/config/ConfigHost.sys.mjs",
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
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs",
);

const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const DIR = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const PAGE = `${DIR}file_vimma_agent_page.html`;
const CLI = {
  name: "claude",
  kind: "cli",
  cli: "claude-code",
  endpoint: "",
  model: "",
  vision: false,
  maxMinutes: 30,
};

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 500);
const agentTabs = () =>
  gBrowser.tabs.filter(
    (t) => t.userContextId === /** @type {any} */ (WorkspaceStore.agent)?.userContextId,
  );

/** This test's own folder in the repository, through `surfer import`'s symlink. */
function repoFile(/** @type {string[]} */ ...parts) {
  const self = getChromeDir(getResolvedURI(gTestPath));
  self.append(gTestPath.split("/").pop());
  self.normalize();
  const repo = self.parent.parent.parent;
  return PathUtils.join(repo.path, ...parts);
}

/** tools/vimma-ctl's binary in this checkout, or null (CI builds it: VIMMA_REQUIRE_CTL). */
async function vimmaCtl() {
  const fromEnv = Services.env.get("VIMMA_CTL");
  if (fromEnv) return fromEnv;
  for (const profile of ["release", "debug"]) {
    const bin = repoFile("tools", "vimma-ctl", "target", profile, "vimma-ctl");
    if (await IOUtils.exists(bin)) return bin;
  }
  return null;
}

/** A task that needs vimma-ctl skips without it, except where CI requires it. */
async function needCtl() {
  const bin = await vimmaCtl();
  if (!bin) {
    Assert.ok(
      Services.env.get("VIMMA_REQUIRE_CTL") !== "1",
      "VIMMA_REQUIRE_CTL=1 (CI) needs tools/vimma-ctl built",
    );
    info("skipped: no tools/vimma-ctl/target/{release,debug}/vimma-ctl");
  }
  return bin;
}

/** The fake CLI, copied as `claude` into a fresh 0700 folder; its report file beside it. */
async function installFake() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-fake-cli", 0o700);
  const bin = PathUtils.join(dir, "claude");
  await IOUtils.copy(repoFile("tests", "browser", "fake_vimma_agent_cli.py"), bin);
  await IOUtils.setPermissions(bin, 0o700);
  const report = PathUtils.join(dir, "report.json");
  Services.env.set("FAKE_CLI_REPORT", report);
  Services.prefs.setStringPref(pathPref("claude-code"), bin);
  return { dir, bin, report };
}

/** @param {string} path */
async function readReport(path) {
  return IOUtils.readJSON(path);
}

/** A conversation with the CLI provider whose notice was answered, as the window does on y. */
function conversation(provider = CLI) {
  const c = AgentChat.create({ provider });
  AgentChat.confirm(c.id, "cli:claude-code");
  return c;
}

/** Sends `text` and waits for the task's end. @param {number} id @param {string} text */
async function run(id, text) {
  const sent = await AgentChat.send(id, text);
  Assert.ok("started" in sent, `the task started: ${JSON.stringify(sent)}`);
  return AgentChat.done(id);
}

const entries = (/** @type {number} */ id) => AgentChat.transcript(id).entries;
/** Steps the gate recorded for the conversation, as its transcript shows them. */
const stepCount = (/** @type {number} */ id) =>
  entries(id).filter((e) => e.kind === "step" || e.kind === "checkpoint").length;
const texts = (/** @type {number} */ id) =>
  entries(id).map((e) => `${e.kind}: ${e.text}${e.outcome ? ` — ${e.outcome}` : ""}`);

let fake = /** @type {{ dir: string, bin: string, report: string }} */ (/** @type {any} */ (null));
let savedConfig = null;

async function tidy() {
  AgentChat.stopAll();
  for (const c of AgentChat.list()) await AgentChat.delete(c.id);
  for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
  AgentGate.revoke();
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "claude", providers: [CLI] });
  const ww = WindowWorkspaces.get(window);
  ww.switchTo({ id: ww.model.workspaces.find((/** @type {any} */ w) => w.name === "main")?.id });
  for (const t of agentTabs()) BrowserTestUtils.removeTab(t);
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  await IOUtils.remove(fake.report, { ignoreAbsent: true });
  Services.prefs.setStringPref(pathPref("claude-code"), fake.bin);
  await VimmaControl.settled();
}

/** @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, tidy));

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [["vimma.mcp.askTimeoutMs", 20000]],
  });
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  fake = await installFake();
  const ctl = await vimmaCtl();
  if (ctl) Services.prefs.setStringPref(VIMMA_CTL_PREF, ctl);
  savedConfig = McpHost.agentConfig;
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "claude", providers: [CLI] });
  registerCleanupFunction(async () => {
    McpHost.configureAgent(savedConfig);
    Services.prefs.clearUserPref(pathPref("claude-code"));
    Services.prefs.clearUserPref(VIMMA_CTL_PREF);
    Services.env.set("FAKE_CLI_REPORT", "");
    await IOUtils.remove(fake.dir, { recursive: true, ignoreAbsent: true });
  });
  await VimmaControl.settled();
});

addTidyTask(async function test_setup_lists_only_found_clis_and_stores_the_path() {
  const path = Services.env.get("PATH");
  try {
    // The fake's own folder first; the rest keeps python3, which runs it.
    Services.env.set("PATH", `${fake.dir}:${path}`);
    const found = await AgentCli.find();
    Assert.deepEqual(
      found.map((f) => f.cli),
      ["claude-code"],
      "the one supported CLI on PATH is listed",
    );
    // The path PATH holds, links kept (C4).
    Assert.equal(found[0].label, `claude 2.1.303 · ${fake.bin}`, "with its version and path");
    Assert.equal(found[0].problem, null, "and nothing wrong with its file");
    Services.env.set("PATH", "/nonexistent-vimma-test");
    Assert.deepEqual(await AgentCli.find(), [], "none found, none listed");
    Assert.equal(
      AgentCli.noneFound(),
      "no agent CLI found on PATH (looked for claude); install one and log in to it first",
      "and setup says which names it looked for",
    );
  } finally {
    Services.env.set("PATH", path);
  }
  Services.prefs.clearUserPref(pathPref("claude-code"));
  AgentCli.use("claude-code", fake.bin);
  Assert.equal(
    Services.prefs.getStringPref(pathPref("claude-code"), ""),
    fake.bin,
    "picking it stores the absolute path in its pref",
  );
});

const $ = (/** @type {string} */ id) => document.getElementById(id);
const notice = () => $("vimma-notice")?.textContent ?? "";
const promptOpen = () => !!$("vimma-rename") && !$("vimma-rename").hidden;
const promptInput = () => /** @type {HTMLInputElement} */ ($("vimma-rename-input"));
const chatRows = () => [
  ...document.querySelectorAll("#vimma-agent-chat-log .vimma-agent-chat-row"),
];

/**
 * The window's setup of the fake CLI, as a user does it: `:agent model` from a page, the
 * `add: agent CLI` row, then the CLI it found, with the fake first on PATH. A config.toml of
 * the test's own takes what setup saves. Resolves with that file's path.
 * @param {(path: string) => Promise<void>} task
 */
async function inWindowSetup(task) {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-cli-config");
  const path = PathUtils.join(dir, "config.toml");
  await IOUtils.writeUTF8(path, "schema = 2\n");
  const PATH = Services.env.get("PATH");
  Services.env.set("PATH", `${fake.dir}:${PATH}`);
  await SpecialPowers.pushPrefEnv({ set: [["vimma.config.path", path]] });
  try {
    await ConfigHost.reload();
    McpHost.configureAgent({ ...AGENT_DEFAULTS, default: null, providers: [] });
    Services.prefs.clearUserPref(pathPref("claude-code"));
    const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE);
    await focusContent(tab.linkedBrowser);
    await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
    await task(path);
  } finally {
    VimmaHost._state(window).agentChat.close();
    Services.env.set("PATH", PATH);
    await SpecialPowers.popPrefEnv();
    await ConfigHost.reload();
    await IOUtils.remove(dir, { recursive: true });
  }
}

/** `:agent model`, then `add: agent CLI` and the CLI it lists first. */
async function pickFoundCli() {
  // From the page, so `:` is Vimma's command line and not text in the window's input.
  VimmaHost._state(window).agentChat.close();
  await focusContent(gBrowser.selectedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("agent model");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => chatRows().some((r) => r.textContent.includes("add: agent CLI (Claude Code)")),
    "the picker offers an agent CLI",
  );
  const at = chatRows().findIndex((r) => r.textContent.includes("add: agent CLI"));
  for (let i = 0; i < chatRows().length; i++) EventUtils.synthesizeKey("k");
  for (let i = 0; i < at; i++) EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => chatRows()[0]?.textContent.includes("claude 2.1.303"),
    "setup lists the CLI found on PATH",
  );
  EventUtils.synthesizeKey("KEY_Enter");
}

/** Replaces the prompt line's text with `text` and submits it. @param {string} text */
function answerPrompt(text) {
  promptInput().select();
  if (text) EventUtils.sendString(text);
  else EventUtils.synthesizeKey("KEY_Backspace");
  EventUtils.synthesizeKey("KEY_Enter");
}

addTidyTask(async function test_setup_asks_the_clis_model_and_saves_it() {
  await inWindowSetup(async (path) => {
    await pickFoundCli();
    await until(promptOpen, "picking a new CLI asks for its model on the prompt line");
    Assert.equal($("vimma-rename").textContent.trim().startsWith("agent model:"), true);
    Assert.equal(promptInput().value, "sonnet", "suggesting Claude Code's model");
    Assert.equal(
      promptInput().placeholder,
      "empty: Claude Code's own default model",
      "and saying what empty means",
    );
    Assert.equal(
      Services.prefs.getStringPref(pathPref("claude-code"), ""),
      "",
      "nothing is stored while the model is asked",
    );
    answerPrompt("--bare");
    await until(
      () => notice().includes('the model "--bare" is not a model name: it cannot start with "-"'),
      `an option as a model is refused where it is typed: ${notice()}`,
    );
    await until(promptOpen, "and asked again");
    Assert.equal(promptInput().value, "--bare", "with what was typed, to correct");
    answerPrompt("opus");
    await until(
      () => notice().includes("agent: claude · opus · saved to config.toml as [agent] default"),
      `the notice names the model and where it went: ${notice()}`,
    );
    const id = /** @type {number} */ (VimmaHost._state(window).agentChat.conversation);
    Assert.equal(AgentChat.get(id).provider.model, "opus", "the conversation uses it");
    Assert.equal(
      Services.prefs.getStringPref(pathPref("claude-code"), "") !== "",
      true,
      "and the CLI's path is stored",
    );
    const text = await IOUtils.readUTF8(path);
    Assert.ok(
      text.includes(
        '[[agent.providers]]\nname = "claude"\nkind = "cli"\ncli = "claude-code"\nmodel = "opus"',
      ),
      `config.toml lists the provider with its model: ${text}`,
    );
    Assert.equal(McpHost.agentConfig?.providers[0]?.model, "opus", "as read back");

    // The CLI listed now: picking it again uses it and asks nothing.
    await pickFoundCli();
    await until(
      () => notice().includes("agent: claude · opus"),
      `the listed provider is used: ${notice()}`,
    );
    Assert.ok(!promptOpen(), "no model is asked for a CLI config.toml lists");
    Assert.equal(await IOUtils.readUTF8(path), text, "and config.toml is unchanged");
  });
});

/** `:agent model` from the page, with the CLI's rows listed. */
async function openModels() {
  VimmaHost._state(window).agentChat.close();
  await focusContent(gBrowser.selectedBrowser);
  await until(() => VimmaHost.status(window).mode === "normal", "the page is in normal mode");
  EventUtils.synthesizeKey(":", { shiftKey: true });
  EventUtils.sendString("agent model");
  EventUtils.synthesizeKey("KEY_Enter");
  await until(
    () => chatRows().some((r) => r.textContent.includes("claude · other model…")),
    "the picker lists the CLI's models",
  );
}

/** Moves the picker's selection to the row whose label starts with `label`. */
function selectRow(/** @type {string} */ label) {
  const at = chatRows().findIndex((r) => r.textContent.startsWith(label));
  Assert.greaterOrEqual(at, 0, `a row ${label}: ${chatRows().map((r) => r.textContent)}`);
  for (let i = 0; i < chatRows().length; i++) EventUtils.synthesizeKey("k");
  for (let i = 0; i < at; i++) EventUtils.synthesizeKey("j");
}

// Behaviour 17: a CLI's model is chosen in the window's picker, as another provider's is.
addTidyTask(async function test_the_picker_lists_the_clis_models_and_uses_one() {
  await inWindowSetup(async (path) => {
    await pickFoundCli();
    await until(promptOpen, "the model is asked");
    answerPrompt("sonnet");
    await until(() => notice().includes("saved to config.toml"), `saved: ${notice()}`);
    const text = await IOUtils.readUTF8(path);
    await openModels();
    const labels = chatRows().map((r) => r.textContent);
    for (const label of [
      "claude · sonnet",
      "claude · opus",
      "claude · haiku",
      "claude · its default model",
      "claude · other model…",
    ]) {
      Assert.ok(
        labels.some((l) => l.startsWith(label)),
        `a row ${label}: ${labels}`,
      );
    }
    const sonnet = chatRows().find((r) => r.textContent.startsWith("claude · sonnet"));
    Assert.ok(
      sonnet?.textContent.includes("in use · config.toml"),
      `the configured model is marked, and in use: ${sonnet?.textContent}`,
    );

    selectRow("claude · opus");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(
      () =>
        notice().includes(
          "agent: claude · opus until a restart; D in the picker makes it the default",
        ),
      `picking a model uses it for this session: ${notice()}`,
    );
    const id = /** @type {number} */ (VimmaHost._state(window).agentChat.conversation);
    Assert.equal(AgentChat.get(id).provider.model, "opus", "the conversation uses it");
    Assert.equal(AgentChat.get(id).provider.cli, "claude-code", "with the same CLI");
    Assert.equal(await IOUtils.readUTF8(path), text, "and config.toml is unchanged");

    await openModels();
    const opus = chatRows().find((r) => r.textContent.startsWith("claude · opus"));
    Assert.ok(opus?.textContent.includes("in use"), `in use: ${opus?.textContent}`);

    selectRow("claude · haiku");
    EventUtils.synthesizeKey("D", { shiftKey: true });
    await until(
      () => notice().includes("agent: claude · haiku · saved to config.toml as [agent] default"),
      `D keeps it: ${notice()}`,
    );
    const saved = await IOUtils.readUTF8(path);
    Assert.ok(
      saved.includes('kind = "cli"\ncli = "claude-code"\nmodel = "haiku"'),
      `config.toml lists it: ${saved}`,
    );
    Assert.equal(McpHost.agentConfig?.default, "claude-2", "as [agent] default");

    await openModels();
    selectRow("claude · other model…");
    EventUtils.synthesizeKey("KEY_Enter");
    await until(promptOpen, "another model is asked by name");
    Assert.equal($("vimma-rename").textContent.trim().startsWith("agent model:"), true);
    answerPrompt("--bare");
    await until(
      () => notice().includes('the model "--bare" is not a model name: it cannot start with "-"'),
      `the same rule refuses it: ${notice()}`,
    );
    await until(promptOpen, "and asks again");
    answerPrompt("claude-opus-4-1");
    await until(
      () => notice().includes("agent: claude · claude-opus-4-1 until a restart"),
      `the typed model is used: ${notice()}`,
    );
    const now = /** @type {number} */ (VimmaHost._state(window).agentChat.conversation);
    Assert.equal(AgentChat.get(now).provider.model, "claude-opus-4-1");
  });
});

addTidyTask(async function test_an_empty_model_leaves_it_to_the_cli() {
  await inWindowSetup(async (path) => {
    await pickFoundCli();
    await until(promptOpen, "the model is asked");
    answerPrompt("");
    await until(
      () => notice().includes("agent: claude · Claude Code's own default model · saved"),
      `the notice says the CLI picks the model: ${notice()}`,
    );
    const id = /** @type {number} */ (VimmaHost._state(window).agentChat.conversation);
    Assert.equal(AgentChat.get(id).provider.model, "", "no model of Vimma's");
    Assert.ok(!(await IOUtils.readUTF8(path)).includes("model ="), "none in config.toml");
  });
});

addTidyTask(async function test_path_checks_refuse_a_file_others_can_write() {
  Assert.equal(await AgentCli.check(fake.bin), null, "the user's own 0700 file in a 0700 folder");
  await IOUtils.setPermissions(fake.bin, 0o722, false);
  try {
    Assert.equal(await AgentCli.check(fake.bin), "other users can write it");
    Assert.equal(await AgentCli.version(fake.bin), null, "nor is it asked its version");
    const c = conversation();
    const result = await run(c.id, "hello");
    Assert.equal(result.outcome, "error", "the task does not start the file");
    Assert.equal(
      result.error,
      `claude-code at ${fake.bin} is refused: other users can write it`,
      "and says why",
    );
    Assert.ok(!(await IOUtils.exists(fake.report)), "the program never ran");
  } finally {
    await IOUtils.setPermissions(fake.bin, 0o700);
  }
  await IOUtils.setPermissions(fake.dir, 0o777, false);
  try {
    Assert.equal(await AgentCli.check(fake.bin), "a folder it is in can be written by other users");
  } finally {
    await IOUtils.setPermissions(fake.dir, 0o700);
  }
  // A folder higher up that others can write (and that is not sticky) could be swapped.
  const outer = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-open", 0o700);
  const inner = PathUtils.join(outer, "bin");
  await IOUtils.makeDirectory(inner, { permissions: 0o700 });
  const deep = PathUtils.join(inner, "claude");
  await IOUtils.copy(fake.bin, deep);
  await IOUtils.setPermissions(deep, 0o700);
  try {
    Assert.equal(await AgentCli.check(deep), null, "every folder above it is sound");
    await IOUtils.setPermissions(outer, 0o777, false);
    Assert.equal(
      await AgentCli.check(deep),
      "a folder it is in can be written by other users",
      "a folder two levels up counts",
    );
    await IOUtils.setPermissions(outer, 0o1777, false);
    Assert.equal(await AgentCli.check(deep), null, "a sticky folder, as /tmp is, does not");
  } finally {
    await IOUtils.setPermissions(outer, 0o700);
    await IOUtils.remove(outer, { recursive: true });
  }
  Assert.equal(await AgentCli.check("claude"), "its path is not absolute");
  Assert.equal(await AgentCli.check("/nonexistent/claude"), "it does not exist");
});

/**
 * A version manager's layout, as mise's: its program, `fakemise`, which runs a tool by the name
 * it is started as, and `shims/claude`, a relative link to it. The fake CLI sits beside it.
 */
async function installShim() {
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-fake-mise", 0o700);
  const program = PathUtils.join(dir, "fakemise");
  await IOUtils.copy(repoFile("tests", "browser", "fake_vimma_agent_dispatcher.py"), program);
  await IOUtils.copy(fake.bin, PathUtils.join(dir, "fake_vimma_agent_cli.py"));
  await IOUtils.setPermissions(program, 0o700);
  const shims = PathUtils.join(dir, "shims");
  await IOUtils.makeDirectory(shims, { permissions: 0o700 });
  const link = PathUtils.join(shims, "claude");
  const ln = await Subprocess.call({ command: "/bin/ln", arguments: ["-s", "../fakemise", link] });
  Assert.equal((await ln.wait()).exitCode, 0, "the shim is made");
  return { dir, program, shims, link };
}

addTidyTask(async function test_a_shim_runs_as_the_cli_it_is_named_after() {
  const shim = await installShim();
  const path = Services.env.get("PATH");
  // PATH's other folders keep python3, which runs the fakes, but no claude of the machine's.
  /** @type {string[]} */
  const rest = [];
  for (const dir of path.split(":")) {
    if (dir && !(await IOUtils.exists(PathUtils.join(dir, "claude")))) rest.push(dir);
  }
  try {
    // Setup keeps the link PATH holds and says what it runs; PATH's own copy of the CLI wins.
    Services.env.set("PATH", [shim.shims, fake.dir, ...rest].join(":"));
    let found = await AgentCli.find();
    Assert.equal(found.length, 1, "one row per CLI");
    Assert.equal(found[0].path, fake.bin, "a CLI that is no shim comes first");
    Services.env.set("PATH", [shim.shims, ...rest].join(":"));
    found = await AgentCli.find();
    Assert.equal(found[0].path, shim.link, "the shim is listed as PATH holds it");
    Assert.equal(
      found[0].label,
      `claude 2.1.303 · ${shim.link} · a fakemise shim (runs ${shim.program} as claude)`,
      "and its row says which program it runs, and as what",
    );
    Assert.equal(found[0].problem, null, "and it may run");
  } finally {
    Services.env.set("PATH", path);
  }
  AgentCli.use("claude-code", shim.link);
  Assert.equal(
    Services.prefs.getStringPref(pathPref("claude-code"), ""),
    shim.link,
    "picking it keeps the link, not the program it resolves to",
  );
  Assert.equal(await AgentCli.check(shim.link), null, "the link and its program are sound");
  await IOUtils.setPermissions(shim.shims, 0o777, false);
  try {
    Assert.equal(
      await AgentCli.check(shim.link),
      "a folder it is in can be written by other users",
      "the folder holding the link is judged as the program's is",
    );
  } finally {
    await IOUtils.setPermissions(shim.shims, 0o700);
  }
  try {
    if (await needCtl()) {
      const c = conversation();
      const result = await run(c.id, "hello");
      Assert.equal(result.outcome, "done", `the shim ran the CLI: ${result.error}`);
      Assert.ok((await readReport(fake.report)).args.includes("-p"), "with its arguments");
      await IOUtils.remove(fake.report);
    }
    // 0.1.13 kept the program a link resolved to: the dispatcher itself, which fails.
    Services.prefs.setStringPref(pathPref("claude-code"), shim.program);
    Assert.equal(
      await AgentCli.availability(CLI),
      "gone",
      "the picker does not offer the dispatcher",
    );
    const c = conversation();
    const refused = await run(c.id, "hello");
    Assert.equal(
      refused.error,
      `claude-code at ${shim.program} is refused: it is fakemise, which runs claude only ` +
        "through a link named claude; add: agent CLI finds it again",
      "a stored dispatcher is refused, with the way to repair it",
    );
    Assert.ok(!(await IOUtils.exists(fake.report)), "and it never ran");
  } finally {
    await IOUtils.remove(shim.dir, { recursive: true });
  }
});

add_task(async function test_agent_clis_are_on_with_a_pref_to_turn_them_off() {
  // builtin-agent-cli, Delivery: Claude Code ships turned on; the pref stays as a way to turn
  // every agent CLI off, and the unfinished-feature pref is gone.
  const defaults = Services.prefs.getDefaultBranch("");
  Assert.equal(CLI_ENABLED_PREF, "vimma.agent.cli.enabled");
  Assert.equal(defaults.getBoolPref(CLI_ENABLED_PREF, false), true, "on by default");
  Assert.equal(
    Services.prefs.getPrefType("vimma.feature.agentCli"),
    Services.prefs.PREF_INVALID,
    "no vimma.feature.agentCli",
  );
  Assert.ok(AgentCli.enabled, "so the window offers agent CLIs");
});

addTidyTask(async function test_turned_off_starts_nothing() {
  const c = conversation();
  await SpecialPowers.pushPrefEnv({ set: [[CLI_ENABLED_PREF, false]] });
  try {
    Assert.deepEqual(await AgentChat.send(c.id, "hello"), {
      refused: "agent CLIs are turned off (vimma.agent.cli.enabled)",
    });
    const direct = await AgentCli.start({
      provider: CLI,
      conn: c.conn,
      state: {},
      text: "hello",
      messages: [],
      budget: /** @type {any} */ ({ exceeded: () => null, step() {} }),
      onEvent() {},
    }).done;
    Assert.equal(direct.outcome, "error", "the runner refuses too");
    Assert.deepEqual(await AgentCli.find(), [], "and setup finds nothing");
    Assert.equal(await AgentCli.version(fake.bin), null, "nor asks a program its version");
    Assert.equal(await AgentCli.availability(CLI), "gone", "and the picker offers no CLI");
    Assert.throws(() => AgentCli.use("claude-code", fake.bin), /off/, "nor keeps a path");
    Assert.ok(!(await IOUtils.exists(fake.report)), "nothing ran");
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

addTidyTask(async function test_a_child_holding_the_output_does_not_keep_the_run() {
  if (!(await needCtl())) return;
  const c = conversation();
  const started = Date.now();
  const result = await run(c.id, "[[orphan]]");
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  Assert.less(Date.now() - started, 10000, "the run ended with the CLI, not with its child");
  Assert.ok(!AgentChat.get(c.id).running, "and the conversation is not left running");
});

addTidyTask(async function test_a_cli_whose_program_is_gone_is_not_available() {
  const key = providerKey(CLI);
  Assert.equal(
    (await AgentChat.modelStates([CLI])).get(key),
    "available",
    "its program is set up and sound",
  );
  Services.prefs.clearUserPref(pathPref("claude-code"));
  Assert.equal((await AgentChat.modelStates([CLI])).get(key), "gone", "no program set up");
  Services.prefs.setStringPref(pathPref("claude-code"), "/nonexistent/claude");
  Assert.equal((await AgentChat.modelStates([CLI])).get(key), "gone", "its program is gone");
  Assert.ok(!(await IOUtils.exists(fake.report)), "and nothing ran to find out");
});

addTidyTask(async function test_no_process_before_a_task() {
  conversation();
  await new Promise((r) => setTimeout(r, 300));
  Assert.ok(!(await IOUtils.exists(fake.report)), "creating a conversation starts nothing");
});

addTidyTask(async function test_task_on_stdin_and_fixed_arguments() {
  if (!(await needCtl())) return;
  const c = conversation({ ...CLI, model: "sonnet" });
  const task = '--dangerously-skip-permissions "quoted" $(rm -rf ~)';
  const result = await run(c.id, task);
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  const report = await readReport(fake.report);
  const config = report.args[report.args.indexOf("--mcp-config") + 1];
  Assert.deepEqual(
    report.args,
    claudeArguments({ mcpConfig: config, model: "sonnet" }),
    "the fixed arguments, with the provider's model",
  );
  Assert.ok(!report.args.join(" ").includes("rm -rf"), "the task is not an argument");
  Assert.equal(report.lines[0].message.content, task, "it is the first line on stdin");
  Assert.deepEqual(report.mcp_servers, ["vimma"], "one MCP server");
  Assert.ok(
    !report.env.some((/** @type {string} */ k) => /^(MOZ_|VIMMA_)/.test(k)),
    "no MOZ_ or VIMMA_ variable reaches the CLI",
  );
});

addTidyTask(async function test_runs_in_an_empty_private_directory_removed_after() {
  if (!(await needCtl())) return;
  const c = conversation();
  await run(c.id, "hello");
  const report = await readReport(fake.report);
  // Claude Code reads instruction files from every folder above its working folder, so no
  // folder above it may be one another user can write, as the shared temporary folder is.
  Assert.ok(!report.cwd.startsWith(PathUtils.tempDir), `not in the shared /tmp: ${report.cwd}`);
  Assert.ok(!report.cwd.startsWith(PathUtils.profileDir), "never in the profile");
  for (let dir = PathUtils.parent(report.cwd); dir; dir = PathUtils.parent(dir)) {
    const { permissions } = await IOUtils.stat(dir);
    Assert.equal(permissions & 0o022, 0, `${dir} cannot be written by other users`);
  }
  Assert.equal(report.dir_mode, "0o700", "a 0700 folder");
  Assert.equal(report.mcp_config_mode, "0o600", "its MCP configuration 0600");
  Assert.ok(!(await IOUtils.exists(report.cwd)), "removed when the run ended");
});

addTidyTask(async function test_a_run_folder_others_can_write_above_is_refused() {
  if (!(await needCtl())) return;
  const runtime = Services.env.get("XDG_RUNTIME_DIR");
  const shared = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-shared", 0o700);
  const base = PathUtils.join(shared, "run");
  await IOUtils.makeDirectory(base, { permissions: 0o700 });
  try {
    // A sticky folder others can write counts too: they could add an instruction file there.
    await IOUtils.setPermissions(shared, 0o1777, false);
    Services.env.set("XDG_RUNTIME_DIR", base);
    const c = conversation();
    const result = await run(c.id, "hello");
    Assert.equal(result.outcome, "error");
    Assert.ok(result.error.endsWith(`${base} is not a private folder of yours`), result.error);
    Assert.ok(!(await IOUtils.exists(fake.report)), "the CLI never ran");
  } finally {
    Services.env.set("XDG_RUNTIME_DIR", runtime);
    await IOUtils.setPermissions(shared, 0o700);
    await IOUtils.remove(shared, { recursive: true });
  }
});

addTidyTask(async function test_ticket_never_in_cmdline_prefs_or_log() {
  if (!(await needCtl())) return;
  const c = conversation();
  await run(c.id, "[[tabs]]");
  const report = await readReport(fake.report);
  Assert.deepEqual(
    report.server_env_keys,
    ["VIMMA_AGENT_PORT", "VIMMA_AGENT_TICKET"],
    "the ticket goes in vimma-ctl's own environment",
  );
  Assert.ok(
    !report.args.some((/** @type {string} */ a) => /[0-9a-f]{64}/.test(a)),
    "and in no argument",
  );
  Assert.deepEqual(report.server_args, ["mcp"]);
  const prefs = Services.prefs.getChildList("vimma.");
  for (const name of prefs) {
    if (Services.prefs.getPrefType(name) !== Services.prefs.PREF_STRING) continue;
    Assert.ok(!/[0-9a-f]{64}/.test(Services.prefs.getStringPref(name)), `not in ${name}`);
  }
  for (const row of AgentGate.log) {
    Assert.ok(!/[0-9a-f]{64}/.test(JSON.stringify(row)), "not in :mcp log");
  }
  for (const line of texts(c.id)) Assert.ok(!/[0-9a-f]{64}/.test(line), "not in the transcript");
});

addTidyTask(async function test_enter_grant_covers_cli_steps_and_checkpoints_ask() {
  if (!(await needCtl())) return;
  const c = conversation();
  const sent = await AgentChat.send(c.id, `[[open ${PAGE}]] [[tabs]] [[show]]`);
  Assert.ok("started" in sent);
  const q = await TestUtils.waitForCondition(
    () => AgentGate.waiting.find((w) => w.conn === c.conn && w.tool === "vimma_show"),
    "vimma_show asks under the conversation grant",
  );
  Assert.ok(q.label.client.startsWith("built-in"), `asked as the conversation: ${q.label.client}`);
  AgentGate.answer(q.id, { kind: "deny" });
  const result = await AgentChat.done(c.id);
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  const lines = texts(c.id);
  Assert.ok(
    lines.some((l) => /^step: opened example\.com — ran under grant$/.test(l)),
    `the open ran under the grant, from the gate: ${lines.join(" | ")}`,
  );
  Assert.ok(
    lines.some((l) => /^step: .* — denied$/.test(l)),
    `the show asked and was denied: ${lines.join(" | ")}`,
  );
  const report = await readReport(fake.report);
  Assert.ok(report.calls.at(-1).isError, "the CLI read the no");
  Assert.equal(agentTabs().length, 1, "its tab is in the agent workspace");
});

addTidyTask(async function test_own_tool_lines_are_marked() {
  if (!(await needCtl())) return;
  const c = conversation();
  await run(c.id, "[[own Bash ls ~/Downloads]]");
  const own = entries(c.id).find((e) => e.kind === "own");
  Assert.equal(own?.text, 'claude-code ran its own tool: Bash "ls ~/Downloads"');
  Assert.ok(!entries(c.id).some((e) => e.kind === "step"), "it is not a step in the browser");
  Assert.ok(
    entries(c.id).some((e) => e.kind === "agent" && e.text === "fake reply: done"),
    "and the reply is the agent's",
  );
});

addTidyTask(async function test_first_task_notice_says_the_clis_own_tools_are_not_confined() {
  const c = AgentChat.create({ provider: CLI });
  Assert.ok(AgentChat.needsNotice(c.id), "a CLI's first task asks first");
  Assert.equal(
    windowNotice(CLI),
    "Page text the agent reads, field values it sees, screenshots and your messages go to " +
      "Claude Code, which sends them to the model it is set up for. Claude Code also keeps the " +
      "tools its own settings allow (shell, files, web); Vimma does not confine them. " +
      "y send · n cancel",
    "the window's notice says where data goes and that the CLI's own tools are not confined",
  );
  const refused = await AgentChat.send(c.id, "hello");
  Assert.ok("refused" in refused, "send itself refuses a task the notice was not answered for");
  Assert.ok(!(await IOUtils.exists(fake.report)), "and starts nothing");
  AgentChat.confirm(c.id, "cli:claude-code");
  Assert.ok(!AgentChat.needsNotice(c.id), "a y covers the conversation's later tasks");
});

addTidyTask(async function test_header_lists_the_clis_own_tools_from_its_init() {
  if (!(await needCtl())) return;
  const c = conversation();
  const before = AgentChat.get(c.id);
  Assert.equal(
    chatHeader({ provider: before.provider, granted: false, cli: before.cli })[1],
    "works in: agent workspace · its own tools: as its configuration allows",
    "before its first run",
  );
  await run(c.id, "hello");
  const after = AgentChat.get(c.id);
  Assert.deepEqual(after.cli, {
    model: "fake-model-1",
    tools: ["Bash", "Read", "Write", "WebFetch", "Edit", "Glob", "Grep"],
  });
  const lines = chatHeader({ provider: after.provider, granted: after.granted, cli: after.cli });
  Assert.equal(lines[0], "claude-code · fake-model-1 · sent where Claude Code sends it");
  Assert.ok(lines[1].endsWith("its own tools: Bash, Read, Write, WebFetch +3"), lines[1]);
  Assert.ok(
    texts(c.id).some(
      (l) =>
        l ===
        "notice: run started: claude-code 2.1.303 · fake-model-1 · its own tools: Bash, Read, Write, WebFetch, Edit, Glob, Grep",
    ),
    `the run-started line lists them all: ${texts(c.id).join(" | ")}`,
  );
});

addTidyTask(async function test_only_vimmas_mcp_server_is_given() {
  if (!(await needCtl())) return;
  const c = conversation();
  await run(c.id, "hello");
  const report = await readReport(fake.report);
  Assert.deepEqual(report.mcp_servers, ["vimma"]);
  Assert.ok(report.args.includes("--strict-mcp-config"), "and every other server left out");
  Assert.equal(report.server_command, Services.prefs.getStringPref(VIMMA_CTL_PREF));
});

addTidyTask(async function test_max_cost_set_is_reported_as_not_applying() {
  if (!(await needCtl())) return;
  const c = conversation();
  await run(c.id, "hello");
  Assert.ok(
    texts(c.id).includes(
      "notice: max_cost does not apply to claude-code: the cost it reports is its own estimate",
    ),
    `the first task says so: ${texts(c.id).join(" | ")}`,
  );
  const budget = AgentChat.get(c.id).budget;
  Assert.equal(budget.reportedCost, 0.41, "its reported cost is kept for the status bar");
  Assert.equal(budget.tokens, 1800, "and its tokens count");
  await run(c.id, "again");
  Assert.equal(
    texts(c.id).filter((l) => l.startsWith("notice: max_cost")).length,
    1,
    "once per conversation",
  );
});

addTidyTask(async function test_the_reported_cost_stays_on_the_end_line() {
  if (!(await needCtl())) return;
  const c = conversation();
  const result = await run(c.id, "hello");
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  // Behaviour 15: the status bar clears when the task ends; the end line keeps the estimate.
  Assert.equal(
    texts(c.id).at(-1),
    "end: done · ≈ $0.41 (claude-code estimate)",
    `the end line names the CLI's own estimate: ${texts(c.id).join(" | ")}`,
  );
});

addTidyTask(async function test_vimma_ctl_beside_the_binary_is_judged_as_the_binary_is() {
  const ctl = await needCtl();
  if (!ctl) return;
  // A folder others can write above the binary's: Vimma's own binary is in it too, so whoever
  // can swap it can change Vimma itself; /Applications on macOS is such a folder.
  const outer = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-app", 0o700);
  const binDir = PathUtils.join(outer, "MacOS");
  await IOUtils.makeDirectory(binDir, { permissions: 0o755 });
  const beside = PathUtils.join(binDir, "vimma-ctl");
  await IOUtils.copy(ctl, beside);
  await IOUtils.setPermissions(beside, 0o755);
  await IOUtils.setPermissions(outer, 0o775, false);
  const real = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  real.initWithPath(beside);
  real.normalize();
  Services.prefs.clearUserPref(VIMMA_CTL_PREF);
  try {
    Assert.deepEqual(
      await AgentCli.findVimmaCtl(binDir),
      { path: real.path },
      "beside the binary, a folder above that others can write does not refuse it",
    );
    await IOUtils.setPermissions(beside, 0o775, false);
    Assert.deepEqual(
      await AgentCli.findVimmaCtl(binDir),
      { problem: `vimma-ctl at ${beside} is refused: other users can write it` },
      "its own file is still checked",
    );
    await IOUtils.setPermissions(beside, 0o755);
    Services.prefs.setStringPref(VIMMA_CTL_PREF, beside);
    Assert.deepEqual(
      await AgentCli.findVimmaCtl(PathUtils.join(outer, "elsewhere")),
      {
        problem: `vimma-ctl at ${beside} is refused: a folder it is in can be written by other users`,
      },
      "the pref's file is judged with every folder above it",
    );
    Services.prefs.clearUserPref(VIMMA_CTL_PREF);
    Assert.deepEqual(
      await AgentCli.findVimmaCtl(PathUtils.join(outer, "elsewhere")),
      { problem: "vimma-ctl is not next to Vimma" },
      "none beside the binary and no pref",
    );
  } finally {
    await IOUtils.setPermissions(outer, 0o700);
    await IOUtils.remove(outer, { recursive: true });
    Services.prefs.setStringPref(VIMMA_CTL_PREF, ctl);
  }
});

addTidyTask(async function test_local_only_refuses_a_cli() {
  const c = conversation();
  McpHost.configureAgent({ ...AGENT_DEFAULTS, localOnly: true, providers: [CLI] });
  const sent = await AgentChat.send(c.id, "hello");
  Assert.deepEqual(sent, {
    refused: "an agent CLI may send page text off this machine ([agent] local_only)",
  });
  const other = AgentChat.create({
    provider: {
      name: "l",
      kind: "openai",
      endpoint: "http://127.0.0.1:9/v1",
      model: "m",
      vision: false,
    },
  });
  Assert.equal(
    AgentChat.setProvider(other.id, CLI),
    "an agent CLI may send page text off this machine ([agent] local_only)",
    "nor is one picked",
  );
  Assert.ok(!(await IOUtils.exists(fake.report)), "nothing started");
});

addTidyTask(async function test_max_steps_counted_by_the_gate() {
  if (!(await needCtl())) return;
  McpHost.configureAgent({ ...AGENT_DEFAULTS, maxSteps: 2, default: "claude", providers: [CLI] });
  const c = conversation();
  AgentGate.grantConnection(c.conn);
  const result = await run(c.id, "[[tabs]] [[tabs]] [[tabs]] [[tabs]]");
  Assert.equal(result.outcome, "budget", `stopped at its budget: ${JSON.stringify(result)}`);
  Assert.deepEqual(result.exceeded, { limit: "steps", used: 2, max: 2 });
  const steps = entries(c.id).filter((e) => e.kind === "step");
  Assert.equal(steps.length, 2, "two steps reached the gate");
});

addTidyTask(async function test_max_tokens_stops_a_turn_before_it_ends() {
  if (!(await needCtl())) return;
  McpHost.configureAgent({
    ...AGENT_DEFAULTS,
    maxTokens: 1000,
    default: "claude",
    providers: [CLI],
  });
  const c = conversation();
  const started = Date.now();
  const result = await run(c.id, "[[usage 1500]] [[sleep 30]]");
  Assert.equal(result.outcome, "budget", `stopped by its tokens: ${JSON.stringify(result)}`);
  Assert.equal(result.exceeded.limit, "tokens");
  Assert.less(Date.now() - started, 15000, "at the model call, not at the turn's end");
});

addTidyTask(async function test_another_mcp_servers_tools_are_listed_as_its_own() {
  if (!(await needCtl())) return;
  Services.env.set("FAKE_CLI_TOOLS", "Bash,mcp__other__fetch");
  try {
    const c = conversation();
    await run(c.id, "hello");
    Assert.deepEqual(AgentChat.get(c.id).cli.tools, ["Bash", "mcp__other__fetch"]);
  } finally {
    Services.env.set("FAKE_CLI_TOOLS", "");
  }
});

addTidyTask(async function test_max_minutes_stops_the_task() {
  if (!(await needCtl())) return;
  const c = conversation({ ...CLI, maxMinutes: 0.02 });
  const started = Date.now();
  const result = await run(c.id, "[[sleep 30]]");
  Assert.equal(result.outcome, "budget", `stopped by time: ${JSON.stringify(result)}`);
  Assert.equal(result.exceeded.limit, "minutes");
  Assert.less(Date.now() - started, 15000, "well before the CLI would have ended");
  Assert.ok(
    texts(c.id).at(-1)?.startsWith("end: stopped: 0.02 minutes, the limit of max_minutes"),
    texts(c.id).at(-1),
  );
});

addTidyTask(async function test_stop_closes_the_connection_before_the_signal() {
  if (!(await needCtl())) return;
  const c = conversation();
  AgentGate.grantConnection(c.conn);
  await AgentChat.send(c.id, "[[loop]]");
  await until(() => stepCount(c.id) >= 2, "it runs steps");
  AgentChat.stop(c.id);
  const atStop = stepCount(c.id);
  const result = await AgentChat.done(c.id);
  Assert.equal(result.outcome, "stopped");
  Assert.lessOrEqual(
    stepCount(c.id),
    atStop + 1,
    "no step after the stop but one already past the gate",
  );
  Assert.equal(texts(c.id).at(-1), "end: stopped");
});

addTidyTask(async function test_cli_that_ignores_sigterm_is_killed_and_takes_no_step() {
  if (!(await needCtl())) return;
  const c = conversation();
  AgentGate.grantConnection(c.conn);
  await AgentChat.send(c.id, "[[ignore-term]] [[loop]]");
  await until(() => stepCount(c.id) >= 2, "it runs steps");
  const stoppedAt = Date.now();
  AgentChat.stop(c.id);
  const atStop = stepCount(c.id);
  const result = await AgentChat.done(c.id);
  const took = Date.now() - stoppedAt;
  Assert.equal(result.outcome, "stopped");
  Assert.greaterOrEqual(took, 2500, `it was given 3 s after SIGTERM: ${took} ms`);
  Assert.less(took, 10000, "then killed");
  Assert.lessOrEqual(stepCount(c.id), atStop + 1, "and took no step in the browser meanwhile");
  const report = await readReport(fake.report);
  Assert.ok(report.ignoring_term, "the fake ignored SIGTERM");
  const after = report.calls.filter((/** @type {any} */ x) => x.at * 1000 > stoppedAt + 200);
  Assert.ok(after.length > 0, "it kept calling after the stop");
  Assert.ok(
    after.every((/** @type {any} */ x) => x.isError),
    "and every call after the stop failed",
  );
});

addTidyTask(async function test_missing_or_failing_cli_reports_its_error() {
  if (!(await needCtl())) return;
  const c = conversation();
  const result = await run(c.id, "[[fail 1 Invalid API key · Please run /login]]");
  Assert.equal(result.outcome, "error");
  // It printed nothing before it failed: the line names the program that ran.
  const failed = `claude-code at ${fake.bin} exited (1): Invalid API key · Please run /login`;
  Assert.equal(result.error, failed);
  Assert.equal(texts(c.id).at(-1), `end: stopped: ${failed}`);
  Services.prefs.clearUserPref(pathPref("claude-code"));
  const missing = await run(c.id, "again");
  Assert.equal(missing.error, "claude-code is not set up: m in the window finds it");
  Services.prefs.setStringPref(pathPref("claude-code"), "/nonexistent/claude");
  const gone = await run(c.id, "again");
  Assert.equal(
    gone.error,
    "claude-code at /nonexistent/claude is refused: it does not exist; " +
      "add: agent CLI finds it again",
  );
});

addTidyTask(async function test_added_instruction_reaches_the_running_cli() {
  if (!(await needCtl())) return;
  const c = conversation();
  await AgentChat.send(c.id, "[[sleep 2]]");
  await until(() => AgentChat.get(c.id).running, "running");
  const steered = await AgentChat.send(c.id, "also this");
  Assert.ok("steered" in steered, "a message during the task is added to it");
  const result = await AgentChat.done(c.id);
  Assert.equal(result.outcome, "done");
  const report = await readReport(fake.report);
  Assert.deepEqual(
    report.lines.map((/** @type {any} */ l) => l.message.content),
    ["[[sleep 2]]", "also this"],
    "written to the CLI's input",
  );
  Assert.ok(report.stdin_closed, "whose input closed with the result");
  Assert.ok(texts(c.id).includes("user: also this (added during the task)"));
});

addTidyTask(async function test_a_later_task_is_a_new_run_given_the_conversation() {
  if (!(await needCtl())) return;
  const c = conversation();
  await run(c.id, "first message");
  await run(c.id, "second message");
  const report = await readReport(fake.report);
  const prompt = report.lines[0].message.content;
  Assert.ok(prompt.includes("first message"), "the stored conversation comes first");
  Assert.ok(prompt.includes("fake reply: done"), "with the reply");
  Assert.ok(prompt.endsWith("second message"), "then the new message");
});
