/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// An agent CLI run by the built-in agent's chat window (docs/specs/builtin-agent-cli.md C2-C10;
// security.md C2's third exception). One task is one run: the program setup confirmed, checked
// again before each run (C4), started with Subprocess and no shell, its arguments from
// core agent-cli.mjs's fixed builder, the task on stdin, in a new empty 0700 folder that goes
// when the run ends (C6). Its only MCP server is `vimma-ctl mcp`, which reaches the browser with
// a one-time ticket bound to the conversation's gate connection (C1, C3): the ticket travels in
// the MCP configuration's `env`, a 0600 file in that folder, never in a command line. The
// stream it prints becomes the transcript's replies and own-tool lines; its steps in the
// browser are the gate's. A stop revokes the ticket, closing its connection, before the
// process is signalled (C9).

import {
  CLIS,
  CLI_STREAM_LIMITS,
  ClaudeStream,
  KILL_GRACE_MS,
  claudeArguments,
  cliEnvironment,
  exitText,
  mcpConfig,
  pathProblem,
  taskPrompt,
  userLine,
  versionArguments,
  versionText,
} from "../core/agent-cli.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AgentDownloads: "chrome://browser/content/vimma/ctl/AgentDownloads.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  Subprocess: "resource://gre/modules/Subprocess.sys.mjs",
  VimmaControl: "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
});

/**
 * Unfinished: off until Codex's pull request (builtin-agent-cli, Delivery; CONTRIBUTING.md,
 * "Unfinished features").
 */
export const CLI_FEATURE_PREF = "vimma.feature.agentCli";
/** The program setup confirmed for a CLI (C4): a pref, never config.toml. @param {string} id */
export const pathPref = (id) => `vimma.agent.cli.${id}.path`;
/**
 * Where `vimma-ctl` is when it is not next to Vimma's binary (a build from source, tests); it
 * is checked as the CLI's own program is, since the CLI runs it with the ticket.
 */
export const VIMMA_CTL_PREF = "vimma.agent.cli.vimmaCtl";
/** `--version` gets this long before it is killed (Behaviour 1). */
const VERSION_MS = 5000;
/** How often the status bar's minutes move while a run lasts. */
const TICK_MS = 30_000;

/**
 * @typedef {import("../core/agent-cli.mjs").CliEvent} CliEvent
 * @typedef {import("../core/agent-loop.mjs").TaskResult} TaskResult
 * @typedef {import("../core/agent-budget.mjs").Budget} Budget
 * @typedef {import("../core/config.mjs").AgentProviderConfig} AgentProviderConfig
 * @typedef {CliEvent | { type: "tick" }} RunEvent
 */

/** A file that passes every check, for a check that fails before the file is read. */
const SOUND = Object.freeze({
  absolute: true,
  regular: true,
  executable: true,
  owner: /** @type {const} */ ("user"),
  othersWrite: false,
  dirOwner: /** @type {const} */ ("user"),
  dirOthersWrite: false,
});

/**
 * Whose a file is: the user's (a no-op chmod works only on one's own file), root's, or
 * another user's.
 * @param {string} path
 * @returns {Promise<"user" | "root" | "other">}
 */
async function ownerOf(path) {
  try {
    const { permissions } = await IOUtils.stat(path);
    await IOUtils.setPermissions(path, permissions, false);
    return "user";
  } catch {
    return lazy.AgentDownloads.ownerUid(path) === 0 ? "root" : "other";
  }
}

/**
 * The program at `path`, checked as C4 says, symlinks resolved: the resolved path, or why it
 * may not run.
 * @param {string} path
 * @returns {Promise<{ path: string } | { problem: string }>}
 */
async function inspect(path) {
  try {
    if (!PathUtils.isAbsolute(path)) {
      return { problem: /** @type {string} */ (pathProblem({ ...SOUND, absolute: false })) };
    }
    const file = new lazy.FileUtils.File(path);
    file.normalize();
    const real = file.path;
    const stat = await IOUtils.stat(real);
    const dir = PathUtils.parent(real) ?? "/";
    const dirStat = await IOUtils.stat(dir);
    const problem = pathProblem({
      absolute: true,
      regular: stat.type === "regular",
      executable: file.isExecutable(),
      owner: await ownerOf(real),
      othersWrite: (stat.permissions & 0o022) !== 0,
      dirOwner: await ownerOf(dir),
      dirOthersWrite: (dirStat.permissions & 0o022) !== 0,
    });
    return problem ? { problem } : { path: real };
  } catch {
    return { problem: "it does not exist" };
  }
}

/**
 * Reads a pipe to its end, keeping its last `keep` characters.
 * @param {any} pipe @param {number} [keep]
 */
async function tail(pipe, keep = CLI_STREAM_LIMITS.stderr) {
  let text = "";
  try {
    for (let s; (s = await pipe.readString());) text = (text + s).slice(-keep);
  } catch {
    // A closed pipe ends it.
  }
  return text;
}

/** `vimma-ctl` beside Vimma's binary, else the pref's; checked as the CLI is (C4). */
async function findVimmaCtl() {
  const candidates = [];
  try {
    const dir = PathUtils.parent(Services.dirsvc.get("XREExeF", Ci.nsIFile).path);
    if (dir) candidates.push(PathUtils.join(dir, "vimma-ctl"));
  } catch {
    // No binary's folder: only the pref.
  }
  const pref = Services.prefs.getStringPref(VIMMA_CTL_PREF, "");
  if (pref) candidates.push(pref);
  for (const path of candidates) {
    if (!(await IOUtils.exists(path))) continue;
    const r = await inspect(path);
    if ("path" in r) return r;
    return { problem: `vimma-ctl at ${path} is refused: ${r.problem}` };
  }
  return { problem: "vimma-ctl is not next to Vimma" };
}

export const AgentCli = {
  get enabled() {
    return Services.prefs.getBoolPref(CLI_FEATURE_PREF, false);
  },

  /**
   * Setup's list (Behaviour 1): each supported CLI that a search of PATH finds, with its path
   * and the version it prints, or why its file may not run. Only while setup asks.
   * @returns {Promise<{ cli: string, path: string, label: string, problem: string | null }[]>}
   */
  async find() {
    const out = [];
    for (const cli of Object.values(CLIS)) {
      let found;
      try {
        found = await lazy.Subprocess.pathSearch(cli.bin);
      } catch {
        continue;
      }
      const r = await inspect(found);
      if ("problem" in r) {
        out.push({ cli: cli.id, path: found, label: `${cli.bin} · ${found}`, problem: r.problem });
        continue;
      }
      const version = await this.version(r.path);
      out.push({
        cli: cli.id,
        path: r.path,
        label: versionText(cli, version ?? "", r.path),
        problem: null,
      });
    }
    return out;
  },

  /** What setup says when `find` lists nothing (Behaviour 1). */
  noneFound() {
    const names = Object.values(CLIS).map((c) => c.bin);
    return (
      `no agent CLI found on PATH (looked for ${names.join(", ")}); ` +
      "install one and log in to it first"
    );
  },

  /**
   * Setup's pick (Behaviour 2, C4): the path the user confirmed is the program a task of this
   * CLI runs, kept in a pref and checked again at each run.
   * @param {string} cli @param {string} path  as `find` listed it
   */
  use(cli, path) {
    if (!Object.hasOwn(CLIS, cli)) throw new Error(`no supported CLI named ${cli}`);
    if (!PathUtils.isAbsolute(path)) throw new Error("the path is not absolute");
    Services.prefs.setStringPref(pathPref(cli), path);
  },

  /**
   * The version the program prints, or null: run with its fixed argument, no shell, in the
   * temporary folder, killed after 5 s.
   * @param {string} path  checked
   */
  async version(path) {
    /** @type {any} */
    let proc;
    /** @type {any} */
    let timer;
    try {
      proc = await lazy.Subprocess.call({
        command: path,
        arguments: versionArguments(),
        environment: cliEnvironment(lazy.Subprocess.getEnvironment()),
        workdir: PathUtils.tempDir,
        stderr: "pipe",
      });
      proc.stdin.close().catch(() => {});
      const err = tail(proc.stderr);
      const out = tail(proc.stdout, 400);
      const late = new Promise((resolve) => {
        timer = lazy.setTimeout(() => resolve(null), VERSION_MS);
      });
      const done = await Promise.race([Promise.all([out, err, proc.wait()]), late]);
      if (!done) {
        proc.kill();
        return null;
      }
      return /** @type {[string, string, any]} */ (done)[0];
    } catch {
      return null;
    } finally {
      lazy.clearTimeout(timer);
    }
  },

  /**
   * Why the program at `path` may not run now, or null (C4).
   * @param {string} path
   */
  async check(path) {
    const r = await inspect(path);
    return "problem" in r ? r.problem : null;
  },

  /**
   * One task of a conversation with a CLI provider (Behaviour 7-16). Resolves to the task's
   * handle, as the model loop's: `stop` (the ticket goes first, then SIGTERM, then SIGKILL
   * after 3 s), `steer` (a line on the CLI's input), and `done`.
   * @param {{ provider: AgentProviderConfig, conn: string,
   *   state: import("../ctl/agent-commands.mjs").AgentConn, text: string,
   *   messages: { role: string, text?: string }[], budget: Budget,
   *   onEvent: (e: RunEvent) => void }} o
   * @returns {{ stop(): void, steer(text: string): void, done: Promise<TaskResult> }}
   */
  start(o) {
    const cli = CLIS[o.provider.cli ?? ""];
    /** @type {any} */
    let proc = null;
    let ticket = "";
    let stopped = false;
    let inputOpen = true;
    /** @type {import("../core/agent-budget.mjs").Exceeded | null} */
    let exceeded = null;
    /** @type {string | null} */
    let failure = null;
    /** Lines waiting for the process to start. @type {string[]} */
    const pending = [];

    const closeInput = () => {
      if (!inputOpen) return;
      inputOpen = false;
      proc?.stdin.close().catch(() => {});
    };
    /** The browser side first, so nothing the CLI does after this reaches it (C9). */
    const end = () => {
      if (ticket) lazy.VimmaControl.revokeTicket(ticket);
      closeInput();
      proc?.kill(KILL_GRACE_MS);
    };
    /** @param {import("../core/agent-budget.mjs").Exceeded} e */
    const overBudget = (e) => {
      exceeded ??= e;
      end();
    };

    const done = (async () => {
      if (!cli)
        return { outcome: "error", error: "this provider names no supported CLI", messages: [] };
      const path = Services.prefs.getStringPref(pathPref(cli.id), "");
      if (!path) {
        return {
          outcome: "error",
          error: `${cli.id} is not set up: m in the window finds it`,
          messages: [],
        };
      }
      const checked = await inspect(path);
      if ("problem" in checked) {
        return {
          outcome: "error",
          error: `${cli.id} at ${path} is refused: ${checked.problem}`,
          messages: [],
        };
      }
      const ctl = await findVimmaCtl();
      if ("problem" in ctl) return { outcome: "error", error: ctl.problem, messages: [] };
      if (stopped) return { outcome: "stopped", messages: [] };
      const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-agent-cli", 0o700);
      /** @type {any} */
      let tick = null;
      /** @type {any} */
      let limit = null;
      try {
        await IOUtils.setPermissions(dir, 0o700);
        const issued = await lazy.VimmaControl.issueTicket({
          conn: o.conn,
          state: o.state,
          label: cli.id,
          onCommand: () => {
            const e = o.budget.exceeded();
            if (e) {
              overBudget(e);
              return "the task reached its budget";
            }
            o.budget.step();
            return null;
          },
        });
        ticket = issued.ticket;
        if (stopped) return { outcome: "stopped", messages: [] };
        // 0600 before the ticket is written into it; the folder is 0700 already.
        const file = PathUtils.join(dir, "mcp.json");
        await IOUtils.writeUTF8(file, "", { mode: "create" });
        await IOUtils.setPermissions(file, 0o600);
        const config = mcpConfig({ vimmaCtl: ctl.path, ticket: issued.ticket, port: issued.port });
        await IOUtils.writeUTF8(file, JSON.stringify(config), { mode: "overwrite" });
        proc = await lazy.Subprocess.call({
          command: checked.path,
          arguments: claudeArguments({ mcpConfig: file, model: o.provider.model }),
          environment: cliEnvironment(lazy.Subprocess.getEnvironment()),
          workdir: dir,
          stderr: "pipe",
        });
        if (stopped) end();
        await proc.stdin.write(userLine(taskPrompt(o.messages, o.text)));
        for (const line of pending.splice(0)) await proc.stdin.write(line);
        const minutes = o.provider.maxMinutes ?? 30;
        limit = lazy.setTimeout(
          () => overBudget({ limit: "minutes", used: minutes, max: minutes }),
          minutes * 60_000,
        );
        tick = lazy.setInterval(() => o.onEvent({ type: "tick" }), TICK_MS);
        const stderr = tail(proc.stderr);
        const stream = new ClaudeStream();
        /** @type {Extract<CliEvent, { type: "result" }> | null} */
        let result = null;
        let reply = "";
        /** @param {CliEvent} e */
        const handle = (e) => {
          if (stopped && e.type !== "result") return;
          if (e.type === "fail") {
            failure ??= e.error;
            end();
            return;
          }
          if (e.type === "reply") reply = e.text;
          if (e.type === "result") {
            result = e;
            if (e.usage) o.budget.addUsage({ ...e.usage, estimated: false });
            if (e.cost !== null) o.budget.reportCost(e.cost);
            // The run ends when nothing is queued: the CLI exits once its input closes.
            if (e.queued === 0) closeInput();
            const over = o.budget.exceeded();
            if (over) overBudget(over);
          }
          o.onEvent(e);
        };
        for (let s; (s = await proc.stdout.readString());) {
          for (const e of stream.push(s)) handle(e);
        }
        for (const e of stream.end()) handle(e);
        const { exitCode } = await proc.wait();
        const errText = await stderr;
        const r = /** @type {Extract<CliEvent, { type: "result" }> | null} */ (result);
        if (exceeded) return { outcome: "budget", exceeded, messages: [] };
        if (stopped) return { outcome: "stopped", messages: [] };
        if (failure) return { outcome: "error", error: failure, messages: [] };
        if (r?.ok && exitCode === 0) {
          return { outcome: "done", reply: reply || "", messages: [] };
        }
        return {
          outcome: "error",
          error: exitText(cli, exitCode, errText, r?.error ?? ""),
          messages: [],
        };
      } finally {
        lazy.clearTimeout(limit);
        lazy.clearInterval(tick);
        // M51: the run's end revokes its ticket.
        if (ticket) lazy.VimmaControl.revokeTicket(ticket);
        await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true }).catch((e) =>
          console.error("vimma agent: a CLI's folder could not be removed", e?.name),
        );
      }
    })().catch((e) => {
      if (ticket) lazy.VimmaControl.revokeTicket(ticket);
      return {
        outcome: /** @type {const} */ ("error"),
        error: `${cli?.id ?? "the CLI"} could not run: ${e?.message ?? e}`,
        messages: [],
      };
    });

    return {
      stop() {
        stopped = true;
        end();
      },
      /** @param {string} text */
      steer(text) {
        // Claude Code reads a line written during a turn within that turn.
        const line = userLine(text);
        if (!inputOpen) return;
        if (proc) proc.stdin.write(line).catch(() => {});
        else pending.push(line);
      },
      done: /** @type {Promise<TaskResult>} */ (done),
    };
  },
};
