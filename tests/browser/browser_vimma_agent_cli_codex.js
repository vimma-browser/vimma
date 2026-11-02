/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent-cli.md, delivery 3 (C2, C3, C7, C8 and Behaviour 10 for
// Codex). A conversation with a Codex provider runs `codex exec` from the path setup confirmed,
// with fixed arguments and the task on stdin, which then closes; Vimma's server is a `-c` table
// that gets the ticket by name from Codex's environment, and every other server of Codex's
// configuration is turned off by name, from `codex mcp list`. Codex reads no input while it
// runs, so a message sent then is held and starts the next run. The CLI is
// fake_vimma_agent_codex.py, which speaks `codex exec --json` and runs no model.

"use strict";

/* global tidyTask -- from head_vimma_control.js */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { AgentChat } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { AgentCli, VIMMA_CTL_PREF, pathPref } = ChromeUtils.importESModule(
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
const { CLIS, codexArguments } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-cli.mjs",
);
const { chatHeader } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-chat.mjs",
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs",
);

const CODEX = {
  name: "codex",
  kind: "cli",
  cli: "codex",
  endpoint: "",
  model: "",
  vision: false,
  maxMinutes: 30,
};

/** @param {() => boolean} cond @param {string} msg */
const until = (cond, msg) => TestUtils.waitForCondition(cond, msg, 20, 500);

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

let fake = /** @type {{ dir: string, bin: string, report: string }} */ (/** @type {any} */ (null));
let savedConfig = null;

/** Each run's report, in the order they ran; none before the first `codex exec`. */
async function runs() {
  return (await IOUtils.exists(fake.report)) ? IOUtils.readJSON(fake.report) : [];
}

/** A conversation with the Codex provider whose notice was answered, as the window does on y. */
function conversation(provider = CODEX) {
  const c = AgentChat.create({ provider });
  AgentChat.confirm(c.id, "cli:codex");
  return c;
}

/** Sends `text` and waits for the task's end. @param {number} id @param {string} text */
async function run(id, text) {
  const sent = await AgentChat.send(id, text);
  Assert.ok("started" in sent, `the task started: ${JSON.stringify(sent)}`);
  return AgentChat.done(id);
}

const entries = (/** @type {number} */ id) => AgentChat.transcript(id).entries;
const texts = (/** @type {number} */ id) =>
  entries(id).map((e) => `${e.kind}: ${e.text}${e.outcome ? ` — ${e.outcome}` : ""}`);

async function tidy() {
  AgentChat.stopAll();
  for (const c of AgentChat.list()) await AgentChat.delete(c.id);
  for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
  AgentGate.revoke();
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "codex", providers: [CODEX] });
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  await IOUtils.remove(fake.report, { ignoreAbsent: true });
  Services.env.set("FAKE_CODEX_SERVERS", "");
  Services.prefs.setStringPref(pathPref("codex"), fake.bin);
  await VimmaControl.settled();
}

/** @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, tidy));

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.mcp.askTimeoutMs", 20000]] });
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-fake-codex", 0o700);
  const bin = PathUtils.join(dir, "codex");
  await IOUtils.copy(repoFile("tests", "browser", "fake_vimma_agent_codex.py"), bin);
  await IOUtils.setPermissions(bin, 0o700);
  fake = { dir, bin, report: PathUtils.join(dir, "report.json") };
  Services.env.set("FAKE_CLI_REPORT", fake.report);
  Services.prefs.setStringPref(pathPref("codex"), bin);
  const ctl = await vimmaCtl();
  if (ctl) Services.prefs.setStringPref(VIMMA_CTL_PREF, ctl);
  savedConfig = McpHost.agentConfig;
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "codex", providers: [CODEX] });
  registerCleanupFunction(async () => {
    McpHost.configureAgent(savedConfig);
    Services.prefs.clearUserPref(pathPref("codex"));
    Services.prefs.clearUserPref(VIMMA_CTL_PREF);
    Services.env.set("FAKE_CLI_REPORT", "");
    Services.env.set("FAKE_CODEX_SERVERS", "");
    await IOUtils.remove(fake.dir, { recursive: true, ignoreAbsent: true });
  });
  await VimmaControl.settled();
});

addTidyTask(async function test_setup_finds_codex_with_its_version() {
  const path = Services.env.get("PATH");
  try {
    // The fake's own folder, and the system's for python3: no real CLI of the machine's.
    Services.env.set("PATH", `${fake.dir}:/usr/bin:/bin`);
    const found = await AgentCli.find();
    Assert.deepEqual(
      found.map((f) => f.cli),
      ["codex"],
      "codex on PATH is listed",
    );
    Assert.equal(found[0].label, `codex 0.163.0 · ${fake.bin}`, "with its version and path");
  } finally {
    Services.env.set("PATH", path);
  }
});

addTidyTask(async function test_task_on_stdin_which_closes_and_fixed_arguments() {
  const ctl = await needCtl();
  if (!ctl) return;
  const c = conversation({ ...CODEX, model: "gpt-6-astra" });
  const task = '--dangerously-bypass-approvals-and-sandbox "quoted" $(rm -rf ~) [[tabs]]';
  const result = await run(c.id, task);
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  const [report] = await runs();
  Assert.deepEqual(
    report.args,
    codexArguments({
      vimmaCtl: ctl,
      dir: report.cwd,
      model: "gpt-6-astra",
      others: ["vimma", "other"],
    }),
    "the fixed arguments, in the run's folder, with the provider's model",
  );
  Assert.ok(!report.args.join(" ").includes("rm -rf"), "the task is not an argument");
  Assert.equal(report.prompt, `${CLIS.codex.note}\n\n${task}\n`, "it is stdin, after the note");
  Assert.ok(report.stdin_closed, "and stdin closed after it, which codex exec waits for");
  Assert.equal(report.calls[0]?.name, "vimma_tabs", "vimma's tool ran through vimma-ctl");
  Assert.ok(!report.calls[0]?.isError, `under the conversation: ${report.calls[0]?.text}`);
  Assert.ok(
    texts(c.id).includes("agent: fake codex: done"),
    `codex's reply is the agent's: ${texts(c.id).join(" | ")}`,
  );
});

addTidyTask(async function test_every_other_server_of_codexs_configuration_is_off() {
  if (!(await needCtl())) return;
  const c = conversation();
  await run(c.id, "[[tabs]]");
  const [report] = await runs();
  const servers = report.config.mcp_servers;
  Assert.deepEqual(Object.keys(servers).sort(), ["other", "vimma", "vimma_chat"]);
  Assert.equal(servers.vimma.enabled, false, "a server of the user's named vimma is off");
  Assert.equal(servers.other.enabled, false, "and every other one");
  Assert.equal(servers.vimma_chat.enabled, true, "vimma's own is on");
  Assert.equal(servers.vimma_chat.required, true, "and the run fails without it");
  Assert.deepEqual(
    report.config.features,
    { apps: false, plugins: false, skill_mcp_dependency_install: false },
    "no apps, plugins or servers a skill installs",
  );
});

addTidyTask(async function test_a_server_named_as_vimmas_refuses_the_run() {
  // The run finds vimma-ctl before it asks codex for its servers.
  if (!(await needCtl())) return;
  Services.env.set("FAKE_CODEX_SERVERS", "vimma_chat");
  const c = conversation();
  const result = await run(c.id, "hello");
  Assert.equal(result.outcome, "error");
  Assert.ok(/vimma_chat, Vimma's own/.test(result.error ?? ""), `said why: ${result.error}`);
  Assert.deepEqual(await runs(), [], "codex exec never ran");
});

addTidyTask(async function test_ticket_by_name_in_codexs_environment_never_an_argument() {
  if (!(await needCtl())) return;
  const c = conversation();
  await run(c.id, "[[tabs]]");
  const [report] = await runs();
  Assert.deepEqual(
    report.server_env_keys,
    ["VIMMA_AGENT_PORT", "VIMMA_AGENT_TICKET"],
    "env_vars forwards the ticket to vimma-ctl",
  );
  Assert.ok(
    !report.args.some((/** @type {string} */ a) => /[0-9a-f]{64}/.test(a)),
    "and no argument holds it",
  );
  Assert.deepEqual(
    report.config.shell_environment_policy.set,
    { VIMMA_AGENT_TICKET: "", VIMMA_AGENT_PORT: "" },
    "codex's own commands get both empty",
  );
  Assert.ok(
    !report.env.some((/** @type {string} */ k) => /^MOZ_/.test(k)),
    "no MOZ_ variable reaches codex",
  );
  for (const line of texts(c.id)) Assert.ok(!/[0-9a-f]{64}/.test(line), "not in the transcript");
});

addTidyTask(async function test_header_and_start_line_name_codexs_configuration() {
  if (!(await needCtl())) return;
  const c = conversation();
  await run(c.id, "hello");
  Assert.ok(
    texts(c.id).includes(
      "notice: run started: codex · its default model · its own tools: as its configuration allows",
    ),
    `codex reports no tools, so its configuration is named: ${texts(c.id).join(" | ")}`,
  );
  const after = AgentChat.get(c.id);
  const lines = chatHeader({ provider: after.provider, granted: after.granted, cli: after.cli });
  Assert.ok(
    lines.some((l) => l.includes("its own tools: as its configuration allows")),
    `the header says so too: ${lines.join(" | ")}`,
  );
});

addTidyTask(async function test_codexs_own_commands_and_files_are_its_own_lines() {
  if (!(await needCtl())) return;
  const c = conversation();
  const result = await run(c.id, "[[own ls ~/Downloads]] [[patch /tmp/x/notes.txt]]");
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  const own = entries(c.id)
    .filter((e) => e.kind === "own")
    .map((e) => e.text);
  Assert.deepEqual(own, [
    "codex ran its own tool: shell \"/usr/bin/bash -lc 'ls ~/Downloads'\"",
    'codex ran its own tool: apply_patch "add /tmp/x/notes.txt"',
  ]);
  Assert.ok(!entries(c.id).some((e) => e.kind === "step"), "neither is a step in the browser");
});

addTidyTask(async function test_a_call_to_a_server_not_vimmas_ends_the_run() {
  if (!(await needCtl())) return;
  const c = conversation();
  const result = await run(c.id, "[[foreign]] [[sleep 5]]");
  Assert.equal(result.outcome, "error");
  Assert.equal(result.error, "codex called an MCP server that is not Vimma's: other");
});

addTidyTask(async function test_a_rejected_key_is_the_runs_error() {
  if (!(await needCtl())) return;
  const c = conversation();
  const result = await run(c.id, "[[bad-key]]");
  Assert.equal(result.outcome, "error");
  Assert.ok(/401 Unauthorized/.test(result.error ?? ""), `codex's own words: ${result.error}`);
});

addTidyTask(async function test_a_message_during_the_task_is_held_for_the_next_run() {
  if (!(await needCtl())) return;
  const c = conversation();
  await AgentChat.send(c.id, "[[sleep 2]]");
  await until(() => AgentChat.get(c.id).running, "running");
  const held = await AgentChat.send(c.id, "also this");
  Assert.ok("held" in held, `held, not added to the run: ${JSON.stringify(held)}`);
  Assert.ok(texts(c.id).includes("user: also this (sent after the running task)"));
  await AgentChat.done(c.id);
  await until(async () => (await runs()).length === 2, "the held message starts a second run");
  await until(() => !AgentChat.get(c.id).running, "which ends");
  const [first, second] = await runs();
  Assert.ok(!first.prompt.includes("also this"), "the running task never saw it");
  Assert.ok(second.prompt.endsWith("also this\n"), "the next run's message is the held one");
  Assert.ok(second.prompt.includes("fake codex: done"), "after the first run's reply");
  Assert.equal(
    texts(c.id).filter((l) => l.startsWith("user: also this")).length,
    1,
    "the transcript shows it once",
  );
});

addTidyTask(async function test_a_held_message_is_not_sent_after_a_stop() {
  if (!(await needCtl())) return;
  const c = conversation();
  await AgentChat.send(c.id, "[[sleep 10]]");
  await until(async () => (await runs())[0]?.stdin_closed, "codex exec runs");
  Assert.ok("held" in (await AgentChat.send(c.id, "later")));
  AgentChat.stop(c.id);
  const result = await AgentChat.done(c.id);
  Assert.equal(result.outcome, "stopped");
  Assert.ok(
    texts(c.id).includes(
      "notice: the message sent after the running task not sent: the task was stopped",
    ),
    `said so: ${texts(c.id).join(" | ")}`,
  );
  await new Promise((r) => setTimeout(r, 500));
  Assert.equal((await runs()).length, 1, "no second run");
});
