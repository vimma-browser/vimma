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

/* global tidyTask -- from head_vimma_control.js */
/* global add_setup -- the browser-chrome harness (browser-test.js) */

Services.scriptloader.loadSubScript(getRootDirectory(gTestPath) + "head_vimma_control.js", this);

const { AgentChat, FEATURE_PREF } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/agent/AgentChat.sys.mjs",
);
const { AgentCli, CLI_FEATURE_PREF, VIMMA_CTL_PREF, pathPref } = ChromeUtils.importESModule(
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
const { claudeArguments } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-cli.mjs",
);
const { chatHeader, sendNotice: windowNotice } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-chat.mjs",
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
    set: [
      [FEATURE_PREF, true],
      [CLI_FEATURE_PREF, true],
      ["vimma.mcp.askTimeoutMs", 20000],
    ],
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

addTidyTask(async function test_path_checks_refuse_a_file_others_can_write() {
  Assert.equal(await AgentCli.check(fake.bin), null, "the user's own 0700 file in a 0700 folder");
  await IOUtils.setPermissions(fake.bin, 0o722, false);
  try {
    Assert.equal(await AgentCli.check(fake.bin), "other users can write it");
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

addTidyTask(async function test_feature_off_starts_nothing() {
  const c = conversation();
  await SpecialPowers.pushPrefEnv({ set: [[CLI_FEATURE_PREF, false]] });
  try {
    Assert.deepEqual(await AgentChat.send(c.id, "hello"), {
      refused: "agent CLIs are unfinished and off (vimma.feature.agentCli)",
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
    "works in: agent workspace · asks every step · its own tools: as its configuration allows",
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
  const c = conversation();
  const result = await run(c.id, "[[fail 1 Invalid API key · Please run /login]]");
  Assert.equal(result.outcome, "error");
  Assert.equal(result.error, "claude-code exited (1): Invalid API key · Please run /login");
  Assert.equal(
    texts(c.id).at(-1),
    "end: stopped: claude-code exited (1): Invalid API key · Please run /login",
  );
  Services.prefs.clearUserPref(pathPref("claude-code"));
  const missing = await run(c.id, "again");
  Assert.equal(missing.error, "claude-code is not set up: m in the window finds it");
  Services.prefs.setStringPref(pathPref("claude-code"), "/nonexistent/claude");
  const gone = await run(c.id, "again");
  Assert.equal(gone.error, "claude-code at /nonexistent/claude is refused: it does not exist");
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
