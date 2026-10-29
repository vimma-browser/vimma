/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// An agent CLI as a provider of the chat window (docs/specs/builtin-agent-cli.md C2, C4-C8), pure:
// the fixed command line of each supported CLI, its MCP configuration, the task it is given on
// stdin, and its streamed JSON output mapped to the transcript's entries. The browser's
// agent/AgentCli.sys.mjs starts the process with these and nothing else: no shell, no argument
// from config.toml, the task never on the command line. The CLI acts on the browser only
// through `vimma-ctl mcp`, bound by a one-time ticket to the conversation's gate connection
// (C1, C3), so the steps it takes in the browser come from the gate, not from this stream.

/**
 * A supported CLI: `id` is its name in config.toml and in the window, `bin` the program setup
 * looks for on PATH, `title` how the window's sentences name it.
 * @typedef {{ id: string, bin: string, title: string }} CliInfo
 */

/** @type {Readonly<Record<string, Readonly<CliInfo>>>} */
export const CLIS = Object.freeze({
  "claude-code": Object.freeze({ id: "claude-code", bin: "claude", title: "Claude Code" }),
});
/** The CLIs a provider may name, in the order setup lists them (C12). */
export const CLI_IDS = Object.freeze(Object.keys(CLIS));
/** The one MCP server a CLI is given: `vimma-ctl mcp` (C7). */
export const MCP_SERVER = "vimma";
/** A CLI task's wall-clock limit, in minutes, unless its provider sets `max_minutes` (C10). */
export const DEFAULT_MAX_MINUTES = 30;
export const MAX_MINUTES = 1440;
/** Native messaging's grace before a forced kill (C9). */
export const KILL_GRACE_MS = 3000;
/** What a line of the transcript keeps of an own-tool step or an error (Behaviour 9, 13). */
export const LINE_CHARS = 200;
/** A line, and a run's whole output, past which the run is stopped (C8); stderr kept for C13. */
export const CLI_STREAM_LIMITS = Object.freeze({
  line: 1024 * 1024,
  total: 64 * 1024 * 1024,
  stderr: 4096,
});

/**
 * C0 and C1 controls but tab and line feed, and the bidi controls (security.md M42): the window
 * removes them again, but a version line or an error is also a notice.
 */
// eslint-disable-next-line no-control-regex -- the control characters are what it removes
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
/** @param {unknown} v */
const plain = (v) => String(v ?? "").replace(UNSAFE, "");
/** @param {string} text @param {number} n */
function cut(text, n = LINE_CHARS) {
  const chars = [...text];
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : text;
}

/**
 * Claude Code's arguments (C2): headless, JSON lines both ways, no session kept, Vimma's MCP
 * server only, which alone gets an allow rule, and no prompt in a run nobody can answer. The
 * CLI's own tools and permission rules stay its settings' (C7). The task goes to stdin.
 * @param {{ mcpConfig: string, model: string }} o  `mcpConfig`: the configuration file's path
 * @returns {string[]}
 */
export function claudeArguments({ mcpConfig, model }) {
  // A model is a word of the CLI's, never an option: `--bare` as a model would be one.
  if (model && (model.startsWith("-") || plain(model) !== model)) {
    throw new Error(`the model "${plain(model)}" is not a model name`);
  }
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--allowedTools",
    `mcp__${MCP_SERVER}`,
    "--permission-mode",
    "dontAsk",
    ...(model ? ["--model", model] : []),
  ];
}

/** `claude --version` (Behaviour 1). */
export const versionArguments = () => ["--version"];

/**
 * The MCP configuration a CLI reads (C3): `vimma-ctl mcp`, with the run's ticket and the
 * socket's port in its own environment, never in a command line.
 * @param {{ vimmaCtl: string, ticket: string, port: number }} o
 */
export function mcpConfig({ vimmaCtl, ticket, port }) {
  return {
    mcpServers: {
      [MCP_SERVER]: {
        type: "stdio",
        command: vimmaCtl,
        args: ["mcp"],
        env: { VIMMA_AGENT_TICKET: ticket, VIMMA_AGENT_PORT: String(port) },
      },
    },
  };
}

/**
 * The CLI's environment (C5): Vimma's own, so the CLI finds its login, HOME and PATH, minus
 * the variables Firefox and Vimma set for themselves, so nothing of the browser's reaches the
 * CLI's shell.
 * @param {Record<string, string>} env
 * @returns {Record<string, string>}
 */
export function cliEnvironment(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    // XRE_ and XUL_ name the profile and the application files.
    if (!/^(MOZ_|VIMMA_|XRE_|XUL_)/.test(k)) out[k] = v;
  }
  return out;
}

/**
 * One line of the CLI's input: a user message, as JSON (C2). Its text is data, so a leading
 * `-` or a quote is plain text.
 * @param {string} text
 */
export function userLine(text) {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/**
 * The task a run is given (C5, Behaviour 12): the conversation's stored messages, replies and
 * summaries before the new message, since the CLI keeps no session between tasks.
 * @param {{ role: string, text?: string }[]} messages  the stored conversation, as sent to a model
 * @param {string} text  the new message
 */
export function taskPrompt(messages, text) {
  const earlier = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.text)
    .map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`);
  if (!earlier.length) return text;
  return (
    "Earlier in this conversation (from Vimma's stored copy):\n\n" +
    `${earlier.join("\n\n")}\n\nThe user's new message:\n\n${text}`
  );
}

/**
 * Setup's line for a CLI it found (Behaviour 1): `claude 2.1.303 · /home/u/.local/bin/claude`.
 * @param {CliInfo} cli @param {string} stdout  of `--version` @param {string} path
 */
export function versionText(cli, stdout, path) {
  const first = plain(stdout.split("\n")[0]).trim();
  const version = first.replace(/\s*\(.*\)\s*$/, "") || "unknown version";
  return `${cli.bin} ${cut(version, 40)} · ${path}`;
}

/**
 * The CLI's own tools as the header lists them (C7): four, then how many more; `null` (a CLI
 * that does not report them) says the configuration decides.
 * @param {string[] | null} tools
 */
export function ownToolsText(tools) {
  if (!tools) return "as its configuration allows";
  if (!tools.length) return "none";
  const shown = tools.slice(0, 4).map((t) => cut(plain(t).replace(/\s+/g, " "), 40));
  return tools.length > 4 ? `${shown.join(", ")} +${tools.length - 4}` : shown.join(", ");
}

/** Tools the run-started line names before `+N`: a CLI's own set is a few dozen. */
const RUN_TOOLS = 60;

/**
 * The transcript's line when a run starts (Behaviour 5): the CLI's version, its model and every
 * tool of its own it reported, each cut, so a CLI's init can never make a line without bound.
 * @param {CliInfo} cli @param {string} version @param {string} model @param {string[]} tools
 */
export function runStartedText(cli, version, model, tools) {
  const names = tools.slice(0, RUN_TOOLS).map((t) => cut(plain(t).replace(/\s+/g, " "), 24));
  const more = tools.length > RUN_TOOLS ? ` +${tools.length - RUN_TOOLS}` : "";
  const head = [`${cli.id}${version ? ` ${cut(plain(version), 40)}` : ""}`];
  head.push(model ? cut(plain(model), 80) : "its default model");
  return (
    `run started: ${head.join(" · ")} · its own tools: ` +
    `${names.length ? names.join(", ") : "none"}${more}`
  );
}

/** The input field that says what an own tool did, by tool: the rest show their input. */
const SUBJECT = Object.freeze({
  Bash: "command",
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  WebFetch: "url",
  WebSearch: "query",
  Glob: "pattern",
  Grep: "pattern",
});

/**
 * A step the CLI took with a tool of its own (Behaviour 9), as the CLI reported it, cut at 200
 * characters; the window marks it so it never reads as a step in the browser.
 * @param {CliInfo} cli @param {unknown} name @param {unknown} input
 */
export function ownToolText(cli, name, input) {
  const tool = plain(name).replace(/\s+/g, " ").trim();
  const field = /** @type {Record<string, string>} */ (SUBJECT)[tool];
  const args = /** @type {Record<string, unknown>} */ (
    input && typeof input === "object" ? input : {}
  );
  const subject =
    field && typeof args[field] === "string"
      ? `"${plain(args[field])}"`
      : plain(JSON.stringify(args) ?? "");
  return cut(`${cli.id} ran its own tool: ${tool} ${subject}`.replace(/\s+/g, " ").trim());
}

/**
 * What the window asks before a conversation's first task with a CLI (Behaviour 4).
 * @param {CliInfo} cli
 */
export function cliNotice(cli) {
  return (
    "Page text the agent reads, field values it sees, screenshots and your messages go to " +
    `${cli.title}, which sends them to the model it is set up for. ${cli.title} also keeps the ` +
    "tools its own settings allow (shell, files, web); Vimma does not confine them. " +
    "y send · n cancel"
  );
}

/**
 * Where a CLI's data goes, as the header's first line says it (Behaviour 5).
 * @param {CliInfo} cli
 */
export const cliWhere = (cli) => `sent where ${cli.title} sends it`;

/**
 * A run that ended without its result (Behaviour 13): the CLI, its exit code and the last line
 * of its error output, or of its result's error, cut at 200 characters.
 * @param {CliInfo} cli @param {number | null} code @param {string} stderr  its last 4 KB
 * @param {string} [error]  the result's error, when the CLI reported one
 */
export function exitText(cli, code, stderr, error = "") {
  const lines = [error, ...stderr.split("\n").reverse()]
    .map((l) => plain(l).trim())
    .filter(Boolean);
  const head = `${cli.id} exited (${code ?? "?"})`;
  return cut(lines.length ? `${head}: ${lines[0]}` : head);
}

/**
 * The program's path checks before each run (C4), from what the browser read of the file:
 * a file another local user can replace would run that user's code as this user.
 * @param {{ absolute: boolean, regular: boolean, executable: boolean,
 *   owner: "user" | "root" | "other", othersWrite: boolean, dirOwner: "user" | "root" | "other",
 *   dirOthersWrite: boolean }} f  `othersWrite`: group or others may write it
 * @returns {string | null}
 */
export function pathProblem(f) {
  if (!f.absolute) return "its path is not absolute";
  if (!f.regular) return "it is not a regular file";
  if (!f.executable) return "it is not executable";
  if (f.owner === "other") return "it is owned by another user";
  if (f.othersWrite) return "other users can write it";
  if (f.dirOwner === "other") return "a folder it is in is owned by another user";
  if (f.dirOthersWrite) return "a folder it is in can be written by other users";
  return null;
}

/**
 * @typedef {{ type: "init", model: string, version: string, tools: string[] }
 *   | { type: "reply", text: string }
 *   | { type: "own-tool", id: string, text: string }
 *   | { type: "own-tool-refused", id: string }
 *   | { type: "usage", input: number, output: number }
 *   | { type: "result", ok: boolean, error: string | null,
 *       usage: { input: number, output: number } | null,
 *       rest: { input: number, output: number } | null, cost: number | null, queued: number }
 *   | { type: "fail", error: string }} CliEvent
 *   What a CLI's stream means for the transcript (C8). `own-tool-refused`: the CLI's own
 *   settings refused that step. `usage`: one model call's tokens, as soon as it is made, so
 *   `max_tokens` can stop a turn before it ends (M59). `rest`: what the turn's `usage` (its
 *   total) adds to the calls already reported. `queued`: turns the CLI still has to run for
 *   lines written during this one. `fail` ends the run.
 */

const CLAUDE = /** @type {CliInfo} */ (CLIS["claude-code"]);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const count = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Claude Code's `stream-json` output read as the transcript's entries (C8): `push` takes the
 * stdout as it comes, `end` once it closed. A `fail` event ends the run, after which nothing
 * more is read. A line or an event it does not know is ignored and counted.
 */
export class ClaudeStream {
  constructor() {
    this.buffer = "";
    this.total = 0;
    this.ignored = 0;
    this.failed = false;
    /** @type {string | null} the version from the init, for a stream that stops parsing */
    this.version = null;
    /** Model calls whose usage was reported, by message id: each repeats it per block. */
    this.calls = new Set();
    /** What this turn's calls reported so far. */
    this.turn = { input: 0, output: 0 };
  }

  /** @param {string} chunk @returns {CliEvent[]} */
  push(chunk) {
    if (this.failed) return [];
    this.total += chunk.length;
    if (this.total > CLI_STREAM_LIMITS.total) {
      return this.fail(`${CLAUDE.id} wrote over 64 MiB`);
    }
    this.buffer += chunk;
    /** @type {CliEvent[]} */
    const out = [];
    let at;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      if (line.length > CLI_STREAM_LIMITS.line) return [...out, ...this.fail(this.tooLong())];
      out.push(...this.line(line));
      if (this.failed) return out;
    }
    if (this.buffer.length > CLI_STREAM_LIMITS.line) return [...out, ...this.fail(this.tooLong())];
    return out;
  }

  /** @returns {CliEvent[]} */
  end() {
    if (this.failed || !this.buffer.trim()) return [];
    const last = this.buffer;
    this.buffer = "";
    return this.line(last);
  }

  /** @private */
  tooLong() {
    return `${CLAUDE.id} wrote a line over 1 MiB`;
  }

  /** @private @param {string} error @returns {CliEvent[]} */
  fail(error) {
    this.failed = true;
    this.buffer = "";
    return [{ type: "fail", error }];
  }

  /** @private */
  unreadable() {
    const v = this.version ? ` ${this.version}` : "";
    return this.fail(`${CLAUDE.id}${v} speaks a stream Vimma does not read`);
  }

  /** @private @param {string} line @returns {CliEvent[]} */
  line(line) {
    if (!line.trim()) return [];
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      this.ignored++;
      return [];
    }
    if (!isObject(m)) {
      this.ignored++;
      return [];
    }
    if (m.type === "system" && m.subtype === "init") return this.init(m);
    if (m.type === "system" && m.subtype === "permission_denied") {
      if (
        typeof m.tool_use_id === "string" &&
        !String(m.tool_name).startsWith(`mcp__${MCP_SERVER}__`)
      ) {
        return [{ type: "own-tool-refused", id: m.tool_use_id }];
      }
      this.ignored++;
      return [];
    }
    if (m.type === "assistant") return this.assistant(m);
    if (m.type === "result") return this.result(m);
    // Other system subtypes (retries, ui_invalidate), tool results' bodies, unknown events.
    this.ignored++;
    return [];
  }

  /** @private @param {Record<string, any>} m @returns {CliEvent[]} */
  init(m) {
    if (typeof m.claude_code_version === "string") this.version = plain(m.claude_code_version);
    const tools = m.tools;
    const servers = m.mcp_servers;
    if (
      !Array.isArray(tools) ||
      !tools.every((t) => typeof t === "string") ||
      !Array.isArray(servers)
    ) {
      return this.unreadable();
    }
    const vimma = servers.find((s) => isObject(s) && s.name === MCP_SERVER);
    if (!vimma || vimma.status !== "connected") {
      return this.fail(`${CLAUDE.id} could not start vimma-ctl`);
    }
    return [
      {
        type: "init",
        model: typeof m.model === "string" ? plain(m.model) : "",
        version: this.version ?? "",
        // The browser's tools are Vimma's own, shown as steps from the gate (C7); any other
        // server's are the CLI's own, and listed as such.
        tools: tools.filter((t) => !t.startsWith(`mcp__${MCP_SERVER}__`)).map(plain),
      },
    ];
  }

  /** @private @param {Record<string, any>} m @returns {CliEvent[]} */
  assistant(m) {
    // A reply the CLI made up for an error (its model is "<synthetic>") repeats the result's
    // error, which the task's end shows.
    if ("error" in m || !isObject(m.message) || !Array.isArray(m.message.content)) {
      this.ignored++;
      return [];
    }
    /** @type {CliEvent[]} */
    const out = [];
    const { id, usage } = m.message;
    if (typeof id === "string" && isObject(usage) && !this.calls.has(id)) {
      this.calls.add(id);
      const input = count(usage.input_tokens) ?? 0;
      const output = count(usage.output_tokens) ?? 0;
      this.turn.input += input;
      this.turn.output += output;
      out.push({ type: "usage", input, output });
    }
    for (const block of m.message.content) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ type: "reply", text: block.text });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        // A step in the browser is the gate's to show, not the CLI's account of it (C8).
        if (block.name.startsWith(`mcp__${MCP_SERVER}__`)) continue;
        out.push({
          type: "own-tool",
          id: typeof block.id === "string" ? block.id : "",
          text: ownToolText(CLAUDE, block.name, block.input),
        });
      }
      // Thinking blocks are not shown.
    }
    return out;
  }

  /** @private @param {Record<string, any>} m @returns {CliEvent[]} */
  result(m) {
    const usage = m.usage;
    if (typeof m.is_error !== "boolean" || (usage !== undefined && !isObject(usage))) {
      return this.unreadable();
    }
    const input = count(usage?.input_tokens);
    const output = count(usage?.output_tokens);
    const error = m.is_error
      ? plain(typeof m.result === "string" && m.result ? m.result : (m.subtype ?? "error"))
      : null;
    const seen = this.turn;
    this.turn = { input: 0, output: 0 };
    const none = input === null && output === null;
    return [
      {
        type: "result",
        ok: !m.is_error,
        error,
        usage: none ? null : { input: input ?? 0, output: output ?? 0 },
        rest: none
          ? null
          : {
              input: Math.max(0, (input ?? 0) - seen.input),
              output: Math.max(0, (output ?? 0) - seen.output),
            },
        cost: count(m.total_cost_usd),
        queued: count(m.queued_turn_count) ?? 0,
      },
    ];
  }
}
