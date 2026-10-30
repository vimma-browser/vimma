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
 * On by default (builtin-agent-cli, Delivery): false turns every agent CLI off, so that none can
 * be set up, listed or started, without a new release.
 */
export const CLI_ENABLED_PREF = "vimma.agent.cli.enabled";
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
/** How long a CLI has to exit after its work is done, and its output to drain after that. */
const EXIT_GRACE_MS = 2000;

/** @param {number} ms */
const delay = (ms) => new Promise((resolve) => lazy.setTimeout(resolve, ms));

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
 * Whose a file is and who may write it, from its owner's uid and its mode (statx or lstat,
 * which keep the sticky bit IOUtils.stat drops): the user's (the profile's owner), root's or
 * another user's. Null when it cannot be read, which no check accepts.
 * @param {string} path
 * @returns {{ owner: "user" | "root" | "other", othersWrite: boolean, sticky: boolean } | null}
 */
function ownership(path) {
  const me = lazy.AgentDownloads.ownerAndMode(PathUtils.profileDir)?.uid;
  const s = lazy.AgentDownloads.ownerAndMode(path);
  if (!s || me === undefined) return null;
  return {
    owner: s.uid === me ? "user" : s.uid === 0 ? "root" : "other",
    othersWrite: (s.mode & 0o022) !== 0,
    sticky: (s.mode & 0o1000) !== 0,
  };
}

/**
 * Every folder from `path`'s up to `/`, judged together (C4): one that another user owns, or
 * that others may write and that is not sticky, could have the file swapped under it. A sticky
 * folder (as /tmp is) lets nobody but its entry's owner replace that entry, whose owner is
 * judged one level down. With `strict` a sticky folder counts too, since another user may add
 * a file of their own to it.
 * @param {string} path @param {boolean} [strict]
 * @returns {{ dirOwner: "user" | "root" | "other", dirOthersWrite: boolean }}
 */
function folders(path, strict = false) {
  /** @type {"user" | "root" | "other"} */
  let dirOwner = "user";
  let dirOthersWrite = false;
  for (let dir = PathUtils.parent(path); dir; dir = PathUtils.parent(dir)) {
    const o = ownership(dir);
    if (!o || o.owner === "other") dirOwner = "other";
    else if (o.othersWrite && (strict || !o.sticky)) dirOthersWrite = true;
  }
  return { dirOwner, dirOthersWrite };
}

/**
 * The program at `path`, checked as C4 says, symlinks resolved: the resolved path, or why it
 * may not run. `folders: false` leaves out the folders above it (vimma-ctl beside Vimma's
 * binary, findVimmaCtl).
 * @param {string} path @param {{ folders?: boolean }} [opts]
 * @returns {Promise<{ path: string } | { problem: string }>}
 */
async function inspect(path, { folders: judgeFolders = true } = {}) {
  try {
    if (!PathUtils.isAbsolute(path)) {
      return { problem: /** @type {string} */ (pathProblem({ ...SOUND, absolute: false })) };
    }
    const file = new lazy.FileUtils.File(path);
    file.normalize();
    const real = file.path;
    const stat = await IOUtils.stat(real);
    const own = ownership(real);
    const problem = pathProblem({
      absolute: true,
      regular: stat.type === "regular",
      executable: file.isExecutable(),
      owner: own?.owner ?? "other",
      othersWrite: own?.othersWrite ?? true,
      ...(judgeFolders ? folders(real) : { dirOwner: "user", dirOthersWrite: false }),
    });
    return problem ? { problem } : { path: real };
  } catch {
    return { problem: "it does not exist" };
  }
}

/**
 * Where a run's folder goes (C6): a folder of the user's, outside the profile, with no folder
 * above it another user can write, because Claude Code reads its project instruction files
 * from every folder above its working folder, so a file planted in a shared /tmp would steer
 * every run. `$XDG_RUNTIME_DIR` (the user's own, 0700, under root's /run) when there is one,
 * else `~/.cache/vimma-agent-cli`, made 0700.
 * @returns {Promise<string>}
 */
async function runBase() {
  const runtime = Services.env.get("XDG_RUNTIME_DIR");
  const home = Services.dirsvc.get("Home", Ci.nsIFile).path;
  const base =
    runtime && PathUtils.isAbsolute(runtime)
      ? runtime
      : PathUtils.join(home, ".cache", "vimma-agent-cli");
  if (!runtime) {
    await IOUtils.makeDirectory(base, { permissions: 0o700, ignoreExisting: true });
  }
  const own = ownership(base);
  const above = folders(base, true);
  if (
    own?.owner !== "user" ||
    own.othersWrite ||
    above.dirOwner === "other" ||
    above.dirOthersWrite
  ) {
    throw new Error(`${base} is not a private folder of yours`);
  }
  return base;
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

/** The folder of Vimma's running binary (the kernel's record of it on Linux), or null. */
function binaryDir() {
  try {
    return PathUtils.parent(Services.dirsvc.get("XREExeF", Ci.nsIFile).path);
  } catch {
    return null;
  }
}

/**
 * `vimma-ctl` in `binDir`, else the pref's; checked as the CLI is (C4), but for the folders
 * above the one beside the binary: they hold Vimma's own binary, so a user who can swap one of
 * them can already change Vimma itself, and judging them would refuse every macOS install,
 * whose /Applications the admin group may write. Its own file is checked in full.
 * @param {string | null} [binDir]
 * @returns {Promise<{ path: string } | { problem: string }>}
 */
async function findVimmaCtl(binDir = binaryDir()) {
  /** @type {{ path: string, beside: boolean }[]} */
  const candidates = [];
  if (binDir) candidates.push({ path: PathUtils.join(binDir, "vimma-ctl"), beside: true });
  const pref = Services.prefs.getStringPref(VIMMA_CTL_PREF, "");
  if (pref) candidates.push({ path: pref, beside: false });
  for (const { path, beside } of candidates) {
    if (!(await IOUtils.exists(path))) continue;
    const r = await inspect(path, { folders: !beside });
    if ("path" in r) return r;
    return { problem: `vimma-ctl at ${path} is refused: ${r.problem}` };
  }
  return { problem: "vimma-ctl is not next to Vimma" };
}

export const AgentCli = {
  findVimmaCtl,

  get enabled() {
    return Services.prefs.getBoolPref(CLI_ENABLED_PREF, false);
  },

  /**
   * Setup's list (Behaviour 1): each supported CLI that a search of PATH finds, with its path
   * and the version it prints, or why its file may not run. Only while setup asks.
   * @returns {Promise<{ cli: string, path: string, label: string, problem: string | null }[]>}
   */
  async find() {
    /** @type {{ cli: string, path: string, label: string, problem: string | null }[]} */
    const out = [];
    if (!this.enabled) return out;
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
   * Setup's pick (Behaviour 2, C4): the path picked there is the program a task of this
   * CLI runs, kept in a pref and checked again at each run.
   * @param {string} cli @param {string} path  as `find` listed it
   */
  use(cli, path) {
    if (!this.enabled) throw new Error(`agent CLIs are turned off (${CLI_ENABLED_PREF})`);
    if (!Object.hasOwn(CLIS, cli)) throw new Error(`no supported CLI named ${cli}`);
    if (!PathUtils.isAbsolute(path)) throw new Error("the path is not absolute");
    Services.prefs.setStringPref(pathPref(cli), path);
  },

  /**
   * The version the program prints, or null: run with its fixed argument, no shell, in the
   * private run folder, killed after 5 s. Only a program that passes C4's checks, and only
   * while agent CLIs are on, whoever calls it.
   * @param {string} path
   */
  async version(path) {
    if (!this.enabled) return null;
    const r = await inspect(path);
    if ("problem" in r) return null;
    /** @type {any} */
    let proc;
    /** @type {any} */
    let timer;
    try {
      proc = await lazy.Subprocess.call({
        command: r.path,
        arguments: versionArguments(),
        environment: cliEnvironment(lazy.Subprocess.getEnvironment()),
        workdir: await runBase(),
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
   * Whether a CLI provider could run now, for the model picker: its path pref is set and the
   * file passes C4's checks. Nothing is started to find out.
   * @param {AgentProviderConfig} provider
   * @returns {Promise<"available" | "gone">}
   */
  async availability(provider) {
    if (!this.enabled) return "gone";
    const path = Services.prefs.getStringPref(pathPref(provider.cli ?? ""), "");
    if (!path || !Object.hasOwn(CLIS, provider.cli ?? "")) return "gone";
    return (await this.check(path)) === null ? "available" : "gone";
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
    /** The task and the lines queued before it are written: a new line may go straight in. */
    let live = false;
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
      if (!AgentCli.enabled) {
        return {
          outcome: "error",
          error: `agent CLIs are turned off (${CLI_ENABLED_PREF})`,
          messages: [],
        };
      }
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
      const dir = await IOUtils.createUniqueDirectory(await runBase(), "vimma-agent-cli", 0o700);
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
        // From the start: a CLI that never reads its input must not hold the task past it.
        const minutes = o.provider.maxMinutes ?? 30;
        limit = lazy.setTimeout(
          () => overBudget({ limit: "minutes", used: minutes, max: minutes }),
          minutes * 60_000,
        );
        tick = lazy.setInterval(() => o.onEvent({ type: "tick" }), TICK_MS);
        if (stopped) end();
        else {
          await proc.stdin.write(userLine(taskPrompt(o.messages, o.text)));
          // Lines added meanwhile, in order, before a later one may go straight to the input.
          while (pending.length) await proc.stdin.write(/** @type {string} */ (pending.shift()));
          live = true;
        }
        const stderr = tail(proc.stderr);
        const stream = new ClaudeStream();
        /** @type {Extract<CliEvent, { type: "result" }> | null} */
        let result = null;
        let reply = "";
        /** @type {() => void} */
        let markFinished = () => {};
        /** A result left nothing queued: the CLI's work is done. */
        const finished = new Promise((resolve) => (markFinished = () => resolve(null)));
        /** @param {CliEvent} e */
        const handle = (e) => {
          if (stopped && e.type !== "result") return;
          if (e.type === "fail") {
            failure ??= e.error;
            end();
            return;
          }
          if (e.type === "reply") reply = e.text;
          if (e.type === "usage") {
            // At each model call, not only at the turn's end, so max_tokens can stop a turn
            // that keeps calling (M59).
            o.budget.addUsage({ input: e.input, output: e.output, estimated: false });
            const over = o.budget.exceeded();
            if (over) {
              overBudget(over);
              return;
            }
          }
          if (e.type === "result") {
            result = e;
            if (e.rest) o.budget.addUsage({ ...e.rest, estimated: false });
            if (e.cost !== null) o.budget.reportCost(e.cost);
            // The run ends when nothing is queued: the CLI exits once its input closes.
            if (e.queued === 0) {
              closeInput();
              markFinished();
            }
            const over = o.budget.exceeded();
            if (over) overBudget(over);
          }
          o.onEvent(e);
        };
        const reading = (async () => {
          for (let s; (s = await proc.stdout.readString());) {
            for (const e of stream.push(s)) handle(e);
          }
        })().catch(() => {});
        const exited = proc.wait();
        // The run is over when its output ends, the CLI exits, or its result left nothing
        // queued. Subprocess sees an exit only when a pipe the CLI held closes, so a child of
        // the CLI that kept one open would hide it; after a grace, kill() reaps an exited CLI
        // (waitpid) and ends a live one, and the run, and its ticket, end with it.
        await Promise.race([reading, exited, finished]);
        const quit = await Promise.race([exited, delay(EXIT_GRACE_MS).then(() => null)]);
        if (!quit) {
          if (ticket) lazy.VimmaControl.revokeTicket(ticket);
          proc.kill(KILL_GRACE_MS);
        }
        const { exitCode } = await exited;
        if (ticket) lazy.VimmaControl.revokeTicket(ticket);
        await Promise.race([reading, delay(EXIT_GRACE_MS)]);
        proc.stdout.close().catch(() => {});
        proc.stderr.close().catch(() => {});
        for (const e of stream.end()) handle(e);
        const errText = await Promise.race([stderr, delay(EXIT_GRACE_MS).then(() => "")]);
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
      proc?.kill(KILL_GRACE_MS);
      // A stop while the task was being written closes the input under the write.
      if (stopped) return { outcome: /** @type {const} */ ("stopped"), messages: [] };
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
        if (live) proc.stdin.write(line).catch(() => {});
        else pending.push(line);
      },
      done: /** @type {Promise<TaskResult>} */ (done),
    };
  },
};
