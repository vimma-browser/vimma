/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/builtin-agent-cli.md, C5 and C12 (Since changed: Gemini CLI). A conversation
// with a Gemini CLI provider runs `gemini` headless from the path setup confirmed, with fixed
// arguments and the task on stdin, which then closes; Vimma's server is in the run folder's
// `.gemini/settings.json` with the ticket in its own `env`, and the run folder is trusted from
// Gemini CLI's environment. Gemini CLI records every run in its own folder, so Vimma removes
// what its runs left there after each run, and the leftovers of runs a crash ended at the next
// start, and nothing of the user's other projects. The CLI is fake_vimma_agent_gemini.py, which
// records as Gemini CLI 0.66.0 does, into GEMINI_CLI_HOME (a throwaway folder), and runs no model.

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
  "chrome://browser/content/vimma/host/AgentGate.sys.mjs",
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
const { CLIS, geminiArguments } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/agent-cli.mjs",
);
const { OSKeyStoreTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/OSKeyStoreTestUtils.sys.mjs",
);
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const GEMINI = {
  name: "gemini",
  kind: "cli",
  cli: "gemini",
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

let fake = /** @type {{ dir: string, bin: string, report: string, home: string }} */ (
  /** @type {any} */ (null)
);
let savedConfig = null;

/** Each run's report, in the order they ran; none before the first run. */
async function runs() {
  return (await IOUtils.exists(fake.report)) ? IOUtils.readJSON(fake.report) : [];
}

/** A conversation with the Gemini CLI provider whose notice was answered, as the window does on y. */
function conversation(provider = GEMINI) {
  const c = AgentChat.create({ provider });
  AgentChat.confirm(c.id, "cli:gemini");
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

/** Gemini CLI's folder in the throwaway home. */
const geminiPath = (/** @type {string[]} */ ...parts) =>
  PathUtils.join(fake.home, ".gemini", ...parts);

/** A project of the user's own, recorded as Gemini CLI records one: never Vimma's to remove. */
async function seedUserProject() {
  const user = "/home/someone/code/vimma-agent-cli";
  await IOUtils.writeJSON(geminiPath("projects.json"), { projects: { [user]: "app" } });
  for (const kind of ["tmp", "history"]) {
    await IOUtils.makeDirectory(geminiPath(kind, "app"), { createAncestors: true });
    await IOUtils.writeUTF8(geminiPath(kind, "app", ".project_root"), user);
  }
  await IOUtils.makeDirectory(geminiPath("tmp", "app", "chats"));
  await IOUtils.writeUTF8(geminiPath("tmp", "app", "chats", "session-1.jsonl"), "{}\n");
}

/** What Gemini CLI's folder holds of each project, as `kind/slug` paths, sorted. */
async function recorded() {
  const out = [];
  for (const kind of ["tmp", "history"]) {
    if (!(await IOUtils.exists(geminiPath(kind)))) continue;
    for (const child of await IOUtils.getChildren(geminiPath(kind))) {
      out.push(`${kind}/${PathUtils.filename(child)}`);
    }
  }
  return out.sort();
}

/** The registry's projects. */
const registry = async () => (await IOUtils.readJSON(geminiPath("projects.json"))).projects;

/** Where runs are made (AgentCli.sys.mjs, runBase). */
function runBase() {
  const runtime = Services.env.get("XDG_RUNTIME_DIR");
  return runtime && PathUtils.isAbsolute(runtime)
    ? runtime
    : PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ".cache", "vimma-agent-cli");
}

async function tidy() {
  AgentChat.stopAll();
  for (const c of AgentChat.list()) await AgentChat.delete(c.id);
  for (const q of AgentGate.waiting) AgentGate.answer(q.id, { kind: "deny" });
  AgentGate.revoke();
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "gemini", providers: [GEMINI] });
  for (const t of gBrowser.tabs.slice(1)) BrowserTestUtils.removeTab(t);
  await IOUtils.remove(fake.report, { ignoreAbsent: true });
  await IOUtils.remove(PathUtils.join(fake.home, ".gemini"), {
    recursive: true,
    ignoreAbsent: true,
  });
  await seedUserProject();
  Services.env.set("FAKE_GEMINI_SERVERS", "");
  Services.prefs.setStringPref(pathPref("gemini"), fake.bin);
  await VimmaControl.settled();
}

/** @param {() => Promise<void>} task */
const addTidyTask = (task) => add_task(tidyTask(task, tidy));

/**
 * Starts the fake once, untimed, with the PATH its setup test gives it, so that its interpreter
 * has started before setup's `--version` gets VERSION_MS: the first python3 start of a fresh
 * macOS runner took 2 to 5 s, and the first fake the suite runs was listed with no version
 * (#917). @param {string} bin @param {string} dir  the fake's folder
 */
async function startInterpreter(bin, dir) {
  const proc = await Subprocess.call({
    command: bin,
    arguments: ["--version"],
    environment: { PATH: `${dir}:/usr/bin:/bin` },
    environmentAppend: true,
  });
  await proc.wait();
}

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({ set: [["vimma.mcp.askTimeoutMs", 20000]] });
  OSKeyStoreTestUtils.setup();
  registerCleanupFunction(() => OSKeyStoreTestUtils.cleanup());
  Services.prefs.setBoolPref(MCP_ENABLED_PREF, false);
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-fake-gemini", 0o700);
  const bin = PathUtils.join(dir, "gemini");
  await IOUtils.copy(repoFile("tests", "browser", "fake_vimma_agent_gemini.py"), bin);
  await IOUtils.setPermissions(bin, 0o700);
  await startInterpreter(bin, dir);
  const home = PathUtils.join(dir, "home");
  await IOUtils.makeDirectory(home, { permissions: 0o700 });
  fake = { dir, bin, report: PathUtils.join(dir, "report.json"), home };
  Services.env.set("FAKE_CLI_REPORT", fake.report);
  // Gemini CLI's folder, for the fake and for Vimma's clean-up alike: never the user's own.
  Services.env.set("GEMINI_CLI_HOME", home);
  Services.prefs.setStringPref(pathPref("gemini"), bin);
  const ctl = await vimmaCtl();
  if (ctl) Services.prefs.setStringPref(VIMMA_CTL_PREF, ctl);
  savedConfig = McpHost.agentConfig;
  McpHost.configureAgent({ ...AGENT_DEFAULTS, default: "gemini", providers: [GEMINI] });
  registerCleanupFunction(async () => {
    McpHost.configureAgent(savedConfig);
    Services.prefs.clearUserPref(pathPref("gemini"));
    Services.prefs.clearUserPref(VIMMA_CTL_PREF);
    Services.env.set("FAKE_CLI_REPORT", "");
    Services.env.set("GEMINI_CLI_HOME", "");
    Services.env.set("FAKE_GEMINI_SERVERS", "");
    await IOUtils.remove(fake.dir, { recursive: true, ignoreAbsent: true });
  });
  await VimmaControl.settled();
});

addTidyTask(async function test_setup_finds_gemini_with_its_version() {
  const path = Services.env.get("PATH");
  try {
    // The fake's own folder, and the system's for python3: no real CLI of the machine's.
    Services.env.set("PATH", `${fake.dir}:/usr/bin:/bin`);
    const found = await AgentCli.find();
    Assert.deepEqual(
      found.map((f) => f.cli),
      ["gemini"],
      "gemini on PATH is listed",
    );
    Assert.equal(found[0].label, `gemini 0.66.0 · ${fake.bin}`, "with its version and path");
  } finally {
    Services.env.set("PATH", path);
  }
});

addTidyTask(async function test_task_on_stdin_fixed_arguments_and_the_folders_settings() {
  const ctl = await needCtl();
  if (!ctl) return;
  const c = conversation({ ...GEMINI, model: "pro" });
  const task = '--yolo "quoted" $(rm -rf ~) [[tabs]]';
  const result = await run(c.id, task);
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  const [report] = await runs();
  Assert.deepEqual(report.args, geminiArguments({ model: "pro" }), "the fixed arguments");
  Assert.ok(!report.args.join(" ").includes("rm -rf"), "the task is not an argument");
  Assert.equal(report.prompt, `${CLIS.gemini.note}\n\n${task}\n`, "it is stdin, after the note");
  Assert.ok(report.stdin_closed, "and stdin closed after it");
  Assert.equal(report.trust, "true", "the run's folder is trusted from the environment");
  Assert.equal(report.tmpdir, report.cwd, "and its reports go to the run's folder");
  Assert.deepEqual(Object.keys(report.settings.mcpServers), ["vimma_chat"], "vimma's server only");
  Assert.equal(report.settings.mcpServers.vimma_chat.command, ctl, "which is vimma-ctl");
  Assert.ok(report.server_trusted, "trusted, as nobody answers a headless run's questions");
  Assert.deepEqual(
    report.server_env_keys,
    ["VIMMA_AGENT_PORT", "VIMMA_AGENT_TICKET"],
    "the ticket reaches vimma-ctl from its entry's env",
  );
  Assert.ok(!report.env.includes("VIMMA_AGENT_TICKET"), "never gemini's own environment");
  Assert.ok(!report.env.some((/** @type {string} */ k) => /^MOZ_/.test(k)), "nor MOZ_ ones");
  Assert.ok(
    !report.args.some((/** @type {string} */ a) => /[0-9a-f]{64}/.test(a)),
    "and no argument holds it",
  );
  Assert.equal(report.calls[0]?.name, "vimma_tabs", "vimma's tool ran through vimma-ctl");
  Assert.ok(!report.calls[0]?.isError, `under the conversation: ${report.calls[0]?.text}`);
  Assert.ok(
    texts(c.id).includes("agent: fake gemini: done"),
    `gemini's reply, joined from its pieces: ${texts(c.id).join(" | ")}`,
  );
  Assert.ok(
    texts(c.id).includes(
      "notice: run started: gemini · pro · its own tools: as its configuration allows",
    ),
    `gemini reports no tools, so its configuration is named: ${texts(c.id).join(" | ")}`,
  );
});

addTidyTask(async function test_gemini_keeps_nothing_of_the_run_after_it() {
  if (!(await needCtl())) return;
  const c = conversation();
  const result = await run(c.id, "[[tabs]] [[own ls /]]");
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  const [report] = await runs();
  Assert.ok(report.session_file, "the fake recorded the run, as gemini does");
  Assert.ok(!(await IOUtils.exists(report.session_file)), "its session file is gone");
  Assert.deepEqual(await recorded(), ["history/app", "tmp/app"], "and its project folders");
  Assert.deepEqual(
    await registry(),
    { "/home/someone/code/vimma-agent-cli": "app" },
    "and its registry entry; the user's own project stays, folders and session included",
  );
  Assert.ok(await IOUtils.exists(geminiPath("tmp", "app", "chats", "session-1.jsonl")));
  Assert.ok(!(await IOUtils.exists(report.cwd)), "the run's folder is gone too");
  const own = entries(c.id).filter((e) => e.kind === "own");
  Assert.equal(own.length, 1, "its own command is its own line");
});

addTidyTask(async function test_a_stopped_run_keeps_nothing_either() {
  if (!(await needCtl())) return;
  const c = conversation();
  await AgentChat.send(c.id, "[[sleep 10]]");
  await until(async () => (await runs())[0]?.session_file, "gemini runs and records");
  AgentChat.stop(c.id);
  const result = await AgentChat.done(c.id);
  Assert.equal(result.outcome, "stopped");
  const [report] = await runs();
  Assert.ok(!(await IOUtils.exists(report.session_file)), "its session file is gone");
  Assert.deepEqual(await recorded(), ["history/app", "tmp/app"], "and its project folders");
});

addTidyTask(async function test_a_rejected_key_is_the_runs_error_and_its_report_goes() {
  if (!(await needCtl())) return;
  const c = conversation();
  const result = await run(c.id, "[[bad-key]]");
  Assert.equal(result.outcome, "error");
  Assert.ok(/API key not valid/.test(result.error ?? ""), `gemini's own words: ${result.error}`);
  Assert.ok(/exited \(145\)/.test(result.error ?? ""), `and its exit code: ${result.error}`);
  const [report] = await runs();
  Assert.ok(!(await IOUtils.exists(report.cwd)), "its error report went with the run's folder");
  Assert.deepEqual(await recorded(), ["history/app", "tmp/app"], "and nothing else is kept");
});

addTidyTask(async function test_leftovers_of_runs_a_crash_ended_go_at_the_next_start() {
  const base = runBase();
  const gone = PathUtils.join(base, "vimma-agent-cli-9999");
  const live = await IOUtils.createUniqueDirectory(base, "vimma-agent-cli", 0o700);
  try {
    const projects = {
      "/home/someone/code/vimma-agent-cli": "app",
      [gone]: "vimma-agent-cli-9999",
      [live]: "live",
    };
    await IOUtils.writeJSON(geminiPath("projects.json"), { projects });
    // A crashed run's folders, one of them no longer in the registry.
    for (const [slug, root] of [
      ["vimma-agent-cli-9999", gone],
      ["orphan", PathUtils.join(base, "vimma-agent-cli-9998")],
      ["live", live],
    ]) {
      for (const kind of ["tmp", "history"]) {
        await IOUtils.makeDirectory(geminiPath(kind, slug), { createAncestors: true });
        await IOUtils.writeUTF8(geminiPath(kind, slug, ".project_root"), root);
      }
    }
    await AgentCli.sweepGemini();
    Assert.deepEqual(
      await recorded(),
      ["history/app", "history/live", "tmp/app", "tmp/live"],
      "a crashed run's folders go; a running one's and the user's stay",
    );
    Assert.deepEqual(
      Object.keys(await registry()).sort(),
      ["/home/someone/code/vimma-agent-cli", live].sort(),
      "and so does its registry entry",
    );
  } finally {
    await IOUtils.remove(live, { recursive: true, ignoreAbsent: true });
  }
});

addTidyTask(async function test_a_lock_gemini_holds_is_waited_for_not_broken() {
  if (!(await needCtl())) return;
  // Gemini CLI locks its registry with a folder beside it (proper-lockfile).
  const lock = geminiPath("projects.json.lock");
  await IOUtils.makeDirectory(lock);
  const c = conversation();
  const done = run(c.id, "hello");
  await until(async () => (await runs())[0]?.exited, "the run ends");
  await new Promise((r) => setTimeout(r, 300));
  Assert.ok(await IOUtils.exists(lock), "vimma leaves gemini's lock alone");
  await IOUtils.remove(lock);
  const result = await done;
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  Assert.deepEqual(
    await registry(),
    { "/home/someone/code/vimma-agent-cli": "app" },
    "and edits the registry once the lock is free",
  );
});

addTidyTask(async function test_a_run_folder_a_crash_left_goes_with_its_records() {
  // Vimma itself crashed: the run folder is still there, with a dead process's mark.
  if (!(await IOUtils.exists("/proc/self"))) {
    info("skipped: a process is known to be gone only through /proc");
    return;
  }
  let dead = 4194000;
  while (await IOUtils.exists(`/proc/${dead}`)) dead++;
  const left = await IOUtils.createUniqueDirectory(runBase(), "vimma-agent-cli", 0o700);
  const live = await IOUtils.createUniqueDirectory(runBase(), "vimma-agent-cli", 0o700);
  try {
    await IOUtils.writeUTF8(PathUtils.join(left, ".vimma-run"), `${dead}\n`);
    await IOUtils.writeUTF8(PathUtils.join(left, "gemini-client-error-x.json"), "{}");
    await IOUtils.writeUTF8(PathUtils.join(live, ".vimma-run"), `${Services.appinfo.processID}\n`);
    const projects = {
      "/home/someone/code/vimma-agent-cli": "app",
      [left]: "left",
      [live]: "live",
    };
    await IOUtils.writeJSON(geminiPath("projects.json"), { projects });
    for (const [slug, root] of [
      ["left", left],
      ["live", live],
    ]) {
      for (const kind of ["tmp", "history"]) {
        await IOUtils.makeDirectory(geminiPath(kind, slug), { createAncestors: true });
        await IOUtils.writeUTF8(geminiPath(kind, slug, ".project_root"), root);
      }
    }
    AgentCli._liveRuns.add(live);
    await AgentCli.sweepGemini();
    Assert.ok(
      !(await IOUtils.exists(left)),
      "the crashed run's folder goes, error reports and all",
    );
    Assert.ok(await IOUtils.exists(live), "a run of this Vimma's that is going stays");
    Assert.deepEqual(
      await recorded(),
      ["history/app", "history/live", "tmp/app", "tmp/live"],
      "and so do their records: the crashed run's go",
    );
    Assert.deepEqual(
      Object.keys(await registry()).sort(),
      ["/home/someone/code/vimma-agent-cli", live].sort(),
    );
  } finally {
    AgentCli._liveRuns.delete(live);
    await IOUtils.remove(left, { recursive: true, ignoreAbsent: true });
    await IOUtils.remove(live, { recursive: true, ignoreAbsent: true });
  }
});

addTidyTask(async function test_a_linked_registry_is_left_a_link() {
  if (!(await needCtl())) return;
  // A dotfile manager's link: Gemini CLI locks and writes the file it leads to, so Vimma does
  // not edit it, and removes only the run's folders.
  const real = PathUtils.join(fake.home, "projects-real.json");
  await IOUtils.writeJSON(real, { projects: { "/home/someone/code/vimma-agent-cli": "app" } });
  await IOUtils.remove(geminiPath("projects.json"));
  const target = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  target.initWithPath(geminiPath("projects.json"));
  // nsIFile has no symlink call: python3 makes the link, as a user's dotfile manager would.
  await new Promise((resolve) => {
    const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
    const py = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    py.initWithPath("/usr/bin/python3");
    proc.init(py);
    const args = ["-c", "import os,sys; os.symlink(sys.argv[1], sys.argv[2])", real, target.path];
    proc.runAsync(args, args.length, { observe: resolve });
  });
  Assert.ok(target.clone().isSymlink(), "the registry is a link");
  const c = conversation();
  const result = await run(c.id, "hello");
  Assert.equal(result.outcome, "done", `done: ${result.error}`);
  Assert.ok(target.clone().isSymlink(), "the registry is still a link");
  Assert.deepEqual(await recorded(), ["history/app", "tmp/app"], "the run's folders are gone");
});
