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

import { hasControl } from "./strings.mjs";
import { tomlLiteral } from "./toml.mjs";

/**
 * @typedef {{ push(chunk: string): CliEvent[], end(): CliEvent[] }} CliStream  a CLI's stdout
 *   read as the transcript's events (C8)
 */

/**
 * A supported CLI, with every fact about it that differs from another's, so that the window,
 * the conversations and the runner read a new CLI from its entry alone (builtin-agent-cli,
 * "Adding a CLI"). `id` is its name in config.toml and in the window, `bin` the program setup
 * looks for on PATH, `title` how the window's sentences name it, `model` the model setup
 * suggests on the prompt line (Behaviour 2), `models` the models the window's picker lists for
 * it (Behaviour 17), "" for the CLI's own default; that list is Vimma's own, and the CLI is
 * never started to list its models. `versionArgs` asks its version (Behaviour 1); `args` builds
 * its command line from the run (`RunArgs`) and the model, refusing a model `modelProblem`
 * refuses (C2); `mcpConfig` is the configuration file it reads, with the ticket in
 * `vimma-ctl mcp`'s environment, or null for a CLI that takes its server in its arguments (C3),
 * and `configFile` where that file goes in the run's folder ("" without one); `env` is what the
 * CLI's own process adds to its environment, for the ticket to reach `vimma-ctl mcp` when the
 * file does not carry it, or for the run's folder to be the CLI's; `sessions` says how the run
 * keeps no session (C5): "none" when the CLI is asked to keep none, "gemini-projects" when Vimma
 * removes what Gemini CLI recorded of the run afterwards; `servers`, for a CLI that cannot leave the
 * MCP servers of its own configuration out with one flag, is the command that lists them and
 * the parser of its output, so that `args` turns each off (C7); `input` is one message on its
 * stdin; `live` says whether the input stays open for messages added during the task, or
 * closes after the task, so that such a message waits for a run of its own (Behaviour 10);
 * `stream` reads its output, with its usage, cost and own tools (C7, C8, C13). `note` opens
 * every task's text (Behaviour 12): `TOOLS_NOTE`, unless a CLI needs its own words.
 * @typedef {{ mcpConfig: string, vimmaCtl: string, dir: string, model: string,
 *   others: string[] }} RunArgs  `mcpConfig`: the configuration file's path, when the CLI has
 *   one; `dir`: the run's folder; `others`: the MCP servers `servers` listed
 * @typedef {{ id: string, bin: string, title: string, model: string,
 *   models: readonly string[], versionArgs: readonly string[], note: string,
 *   args: (o: RunArgs) => string[],
 *   mcpConfig: (o: { vimmaCtl: string, ticket: string, port: number }) => object | null,
 *   configFile: string, sessions: "none" | "gemini-projects",
 *   env: (o: { ticket: string, port: number, dir: string }) => Record<string, string>,
 *   servers: { args: readonly string[], parse: (stdout: string) => string[] | { problem: string } }
 *     | null,
 *   input: (text: string) => string, live: boolean,
 *   stream: (o?: { model?: string }) => CliStream }} CliInfo
 */

/**
 * The sentence a CLI's task starts with (Behaviour 12). A CLI runs headless with only Vimma's
 * tools allowed in advance (C2, C7), so its own web search or fetch is refused, and a model
 * that meets the refusal tends to stop; told first, it searches and reads through the agent
 * workspace, under the gate's questions and grants.
 */
export const TOOLS_NOTE =
  "Vimma's note: search the web and read pages with Vimma's tools in the agent workspace " +
  "(for example, open a search engine's results page with vimma_open and read it with " +
  "vimma_read_page); tools of your own that this run was not allowed in advance are refused.";

/** @type {Readonly<Record<string, Readonly<CliInfo>>>} */
export const CLIS = Object.freeze({
  "claude-code": Object.freeze({
    id: "claude-code",
    bin: "claude",
    title: "Claude Code",
    model: "sonnet",
    // Claude Code's model aliases, which follow its newest model of each family.
    models: Object.freeze(["sonnet", "opus", "haiku", ""]),
    versionArgs: Object.freeze(["--version"]),
    note: TOOLS_NOTE,
    args: (/** @type {RunArgs} */ o) => claudeArguments(o),
    mcpConfig: (/** @type {{ vimmaCtl: string, ticket: string, port: number }} */ o) =>
      mcpConfig(o),
    configFile: "mcp.json",
    // --no-session-persistence.
    sessions: "none",
    // The ticket is in the configuration file, for vimma-ctl only.
    env: () => ({}),
    // --strict-mcp-config leaves every other server out.
    servers: null,
    input: (/** @type {string} */ text) => userLine(text),
    live: true,
    // Called only once the module has run, after the class is defined.
    stream: () => new ClaudeStream(),
  }),
  codex: Object.freeze({
    id: "codex",
    bin: "codex",
    title: "Codex",
    // Codex's own default: its models change with its releases, faster than Vimma's.
    model: "",
    // Codex 0.163.0's presets.
    models: Object.freeze(["", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]),
    versionArgs: Object.freeze(["--version"]),
    note: TOOLS_NOTE,
    args: (/** @type {RunArgs} */ o) => codexArguments(o),
    // Its server is a `-c` table of its arguments.
    mcpConfig: () => null,
    configFile: "",
    // --ephemeral.
    sessions: "none",
    // Forwarded to vimma-ctl by name (`env_vars`), so no value is in an argument (C3).
    env: (/** @type {{ ticket: string, port: number }} */ { ticket, port }) => ({
      VIMMA_AGENT_TICKET: ticket,
      VIMMA_AGENT_PORT: String(port),
    }),
    servers: Object.freeze({
      args: Object.freeze(["mcp", "list", "--json"]),
      parse: (/** @type {string} */ stdout) => codexServers(stdout),
    }),
    // `codex exec` reads its prompt from stdin to its end.
    input: (/** @type {string} */ text) => `${text}\n`,
    live: false,
    stream: (/** @type {{ model?: string }} */ o = {}) => new CodexStream(o),
  }),
  gemini: Object.freeze({
    id: "gemini",
    bin: "gemini",
    title: "Gemini CLI",
    // Its own default is its router (`auto`), which picks a model per request.
    model: "",
    // Gemini CLI 0.66.0's aliases, which follow its newest model of each kind.
    models: Object.freeze(["", "pro", "flash", "flash-lite"]),
    versionArgs: Object.freeze(["--version"]),
    note: TOOLS_NOTE,
    args: (/** @type {RunArgs} */ o) => geminiArguments(o),
    mcpConfig: (/** @type {{ vimmaCtl: string, ticket: string, port: number }} */ o) =>
      geminiSettings(o),
    // Read from the working directory, which is the run's folder: no argument names it.
    configFile: ".gemini/settings.json",
    // Gemini CLI records every run, with no setting that turns it off (C5).
    sessions: "gemini-projects",
    // A headless run needs its folder trusted; --skip-trust trusts it but skips the folder's
    // settings file, which holds Vimma's server. Its error reports hold the conversation and
    // go to TMPDIR, so they stay in the run's folder, which goes when the run ends.
    env: (/** @type {{ ticket: string, port: number, dir: string }} */ { dir }) => ({
      GEMINI_CLI_TRUST_WORKSPACE: "true",
      TMPDIR: dir,
    }),
    // --allowed-mcp-server-names leaves every other server out.
    servers: null,
    // It reads its task from stdin to its end.
    input: (/** @type {string} */ text) => `${text}\n`,
    live: false,
    stream: (/** @type {{ model?: string }} */ o = {}) => new GeminiStream(o),
  }),
});
/** The CLIs a provider may name, in the order setup lists them (C12). */
export const CLI_IDS = Object.freeze(Object.keys(CLIS));
/** The one MCP server a CLI is given: `vimma-ctl mcp` (C7). */
export const MCP_SERVER = "vimma";
/**
 * Vimma's server in a Codex run, named apart from the `vimma` that the guide has a user add to
 * `~/.codex/config.toml` for MCP: Codex merges a `-c` table into one of the same name, so that
 * server's own keys (`enabled_tools`, `env`) would reach Vimma's, and it is turned off instead.
 */
export const CODEX_SERVER = "vimma_chat";
/**
 * Vimma's server in a Gemini CLI run, named apart from a `vimma` of the user's settings for the
 * same reason as Codex's; the run folder's entry would replace that one whole, and the tools
 * reach the model as `mcp_vimma_chat_<tool>`.
 */
export const GEMINI_SERVER = "vimma_chat";
/** Codex's features that add MCP servers outside its list, off for each run (C7). */
const CODEX_FEATURES_OFF = Object.freeze(["apps", "plugins", "skill_mcp_dependency_install"]);
/** A server name Codex's list may hold that goes into a `-c` key unquoted. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The most servers a Codex configuration may list for a run to start. */
const MAX_SERVERS = 200;
/** A model's longest name, in characters: a provider's `model` in config.toml, any kind. */
export const MAX_MODEL = 200;
/** A CLI task's wall-clock limit, in minutes, unless its provider sets `max_minutes` (C10). */
export const DEFAULT_MAX_MINUTES = 30;
export const MAX_MINUTES = 1440;
/** Native messaging's grace before a forced kill (C9). */
export const KILL_GRACE_MS = 3000;
/** `--version` gets this long before it is killed (Behaviour 1). */
export const VERSION_MS = 5000;
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
 * Why `model` cannot be a CLI's model, or null (C2, Behaviour 2): a model is a word of the
 * CLI's, never an option (`--bare` as a model would be one), plain text without any control
 * character (a line break included) and at most MAX_MODEL characters. Setup's prompt line,
 * config.toml and the command line all apply this rule, so a bad model is refused where it is
 * typed rather than when a task starts or when it is saved. Empty is allowed: the CLI's own
 * default.
 * @param {string} model
 * @returns {string | null}
 */
export function modelProblem(model) {
  const why = model.startsWith("-")
    ? 'it cannot start with "-"'
    : hasControl(model) || plain(model) !== model
      ? "it has control characters"
      : [...model].length > MAX_MODEL
        ? `it is longer than ${MAX_MODEL} characters`
        : null;
  return (
    why && `the model "${cut(plain(model).replace(/[\t\n]/g, " "))}" is not a model name: ${why}`
  );
}

/**
 * Setup's prompt line for a CLI's model (Behaviour 2): the CLI's suggested model, editable;
 * cleared, the placeholder says that empty leaves the choice to the CLI.
 * @param {string} cli  a key of `clis`
 * @param {Readonly<Record<string, { title: string, model: string }>>} [clis]
 */
export function modelPrompt(cli, clis = CLIS) {
  const info = clis[cli];
  return {
    label: "agent model: ",
    value: info?.model ?? "",
    placeholder: `empty: ${info?.title ?? cli}'s own default model`,
  };
}

/**
 * A CLI provider's model as a notice names it.
 * @param {string} cli  a key of `clis`
 * @param {string} model
 * @param {Readonly<Record<string, { title: string }>>} [clis]
 */
export const cliModelText = (cli, model, clis = CLIS) =>
  model || `${clis[cli]?.title ?? cli}'s own default model`;

/**
 * Claude Code's arguments (C2): headless, JSON lines both ways, no session kept, Vimma's MCP
 * server only, which alone gets an allow rule, and no prompt in a run nobody can answer. The
 * CLI's own tools and permission rules stay its settings' (C7). The task goes to stdin.
 * @param {{ mcpConfig: string, model: string }} o  `mcpConfig`: the configuration file's path
 * @returns {string[]}
 */
export function claudeArguments({ mcpConfig, model }) {
  const problem = modelProblem(model);
  if (problem) throw new Error(problem);
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

/** The variables that carry the ticket to vimma-ctl when a CLI's server takes no file (C3). */
const TICKET_VARIABLES = Object.freeze(["VIMMA_AGENT_TICKET", "VIMMA_AGENT_PORT"]);

/**
 * Codex's arguments (C2, C3, C7): `exec`, JSON lines out, no session kept, the run's folder as
 * its working directory, Vimma's MCP server as a `-c` table, every other server of its
 * configuration turned off, its apps and plugins (which bring servers of their own) off, and
 * the task on stdin (`-`). Codex has no flag that leaves the servers of its configuration out,
 * so each one `codex mcp list` named is turned off by name. The ticket and the port are in
 * Codex's own environment, which `env_vars` forwards to vimma-ctl alone; Codex's tools need no
 * approval for Vimma's server (`default_tools_approval_mode`), since a run nobody answers would
 * refuse every call, and the run fails if vimma-ctl does not start (`required`). Its sandbox and
 * approvals stay its configuration's (C7).
 * @param {RunArgs} o
 * @returns {string[]}
 */
export function codexArguments({ vimmaCtl, dir, model, others }) {
  const problem = modelProblem(model);
  if (problem) throw new Error(problem);
  for (const name of others) {
    if (name === CODEX_SERVER) {
      throw new Error(`codex's configuration has an MCP server named ${CODEX_SERVER}, Vimma's own`);
    }
    if (!SERVER_NAME.test(name)) {
      throw new Error("codex's configuration has an MCP server whose name Vimma cannot turn off");
    }
  }
  const server = [
    `command=${tomlLiteral(vimmaCtl)}`,
    'args=["mcp"]',
    `env_vars=[${TICKET_VARIABLES.map((v) => `"${v}"`).join(",")}]`,
    'default_tools_approval_mode="approve"',
    "required=true",
    "enabled=true",
  ];
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    dir,
    "-c",
    `mcp_servers.${CODEX_SERVER}={${server.join(",")}}`,
    // Codex gives its own commands its environment: the ticket's variables are set empty for
    // them (C3). A `set` key merges into the user's table; an `exclude` list would replace it.
    ...TICKET_VARIABLES.flatMap((name) => ["-c", `shell_environment_policy.set.${name}=""`]),
    ...others.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]),
    // Its apps and plugins bring MCP servers of their own, and a skill's MCP dependency is
    // installed during a run (C7). As a -c key a feature Codex does not know is ignored; as
    // --disable it ends the run, so a version that renames one fails instead of keeping it.
    ...CODEX_FEATURES_OFF.flatMap((name) => ["--disable", name]),
    ...(model ? ["-m", model] : []),
    "-",
  ];
}

/**
 * The names of the MCP servers `codex mcp list --json` printed, enabled or not, or why the
 * run may not start: a server Vimma cannot read is one it cannot turn off.
 * @param {string} stdout
 * @returns {string[] | { problem: string }}
 */
export function codexServers(stdout) {
  const problem = { problem: "codex listed its MCP servers in a form Vimma does not read" };
  let list;
  try {
    list = JSON.parse(stdout);
  } catch {
    return problem;
  }
  if (
    !Array.isArray(list) ||
    list.length > MAX_SERVERS ||
    !list.every((s) => isObject(s) && typeof s.name === "string")
  ) {
    return problem;
  }
  return list.map((s) => s.name);
}

/**
 * Gemini CLI's arguments (C2, C7): JSON lines out, Vimma's server the only one allowed to start
 * (`--allowed-mcp-server-names`), and no extensions, which bring MCP servers, tools and context
 * of their own. Headless because its input is a pipe; the task goes to stdin, never an argument.
 * Its approval mode and policies stay its configuration's (C7): headless, it offers the model
 * only tools that need no confirmation unless a policy of the user's allows more.
 * @param {{ model: string }} o
 * @returns {string[]}
 */
export function geminiArguments({ model }) {
  const problem = modelProblem(model);
  if (problem) throw new Error(problem);
  return [
    "-o",
    "stream-json",
    "--allowed-mcp-server-names",
    GEMINI_SERVER,
    "-e",
    "none",
    ...(model ? ["-m", model] : []),
  ];
}

/**
 * The `.gemini/settings.json` of a Gemini CLI run's folder (C3): `vimma-ctl mcp` with the ticket
 * in its own environment, and `trust`, since a headless run asks nobody before a tool call.
 * @param {{ vimmaCtl: string, ticket: string, port: number }} o
 */
export function geminiSettings({ vimmaCtl, ticket, port }) {
  return {
    mcpServers: {
      [GEMINI_SERVER]: {
        command: vimmaCtl,
        args: ["mcp"],
        env: { VIMMA_AGENT_TICKET: ticket, VIMMA_AGENT_PORT: String(port) },
        trust: true,
      },
    },
  };
}

/** A run folder's name (AgentCli.sys.mjs, IOUtils.createUniqueDirectory). */
const RUN_FOLDER = /^vimma-agent-cli(-\d+)?$/;
/** A Gemini CLI project folder's name, as its registry gives it: one plain folder name. */
const GEMINI_SLUG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;

/**
 * Whether `path`, a project in Gemini CLI's registry, is a run folder of Vimma's (C5): a folder
 * named as Vimma names one, right inside one of the folders runs are made in. Nothing else
 * of the user's Gemini CLI projects is ever removed.
 * @param {string} path @param {readonly string[]} bases  where runs are made
 */
export function geminiLeftover(path, bases) {
  const at = path.lastIndexOf("/");
  if (at <= 0) return false;
  return bases.includes(path.slice(0, at)) && RUN_FOLDER.test(path.slice(at + 1));
}

/**
 * Gemini CLI's project registry (`~/.gemini/projects.json`, `{ projects: { path: slug } }`)
 * without the projects `ours` picks (C5), and their project folders' names; `slug` is null when
 * the name is not one plain folder name, so no folder is removed for it. `text` is null when
 * there is nothing to change, or the registry is not in that form.
 * @param {string} text @param {(path: string) => boolean} ours
 * @returns {{ text: string | null, removed: { path: string, slug: string | null }[] }}
 */
export function geminiProjects(text, ours) {
  const none = { text: null, removed: [] };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return none;
  }
  if (!isObject(data) || !isObject(data.projects)) return none;
  const entries = Object.entries(data.projects);
  if (!entries.every(([, v]) => typeof v === "string")) return none;
  /** @type {{ path: string, slug: string | null }[]} */
  const removed = [];
  /** @type {Record<string, string>} */
  const kept = {};
  for (const [path, slug] of entries) {
    if (!ours(path)) kept[path] = slug;
    else removed.push({ path, slug: GEMINI_SLUG.test(slug) ? slug : null });
  }
  if (!removed.length) return none;
  return { text: JSON.stringify({ ...data, projects: kept }, null, 2), removed };
}

/**
 * The MCP configuration Claude Code reads (C3): `vimma-ctl mcp`, with the run's ticket and the
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
 * One line of Claude Code's input: a user message, as JSON (C2). Its text is data, so a leading
 * `-` or a quote is plain text.
 * @param {string} text
 */
export function userLine(text) {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/**
 * The task a run is given (C5, Behaviour 12): the CLI's `note`, then the conversation's stored
 * messages, replies and summaries before the new message, since the CLI keeps no session
 * between tasks.
 * @param {{ role: string, text?: string }[]} messages  the stored conversation, as sent to a model
 * @param {string} text  the new message
 * @param {string} [note]  the CLI's `note`
 */
export function taskPrompt(messages, text, note = "") {
  const earlier = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.text)
    .map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`);
  const body = earlier.length
    ? "Earlier in this conversation (from Vimma's stored copy):\n\n" +
      `${earlier.join("\n\n")}\n\nThe user's new message:\n\n${text}`
    : text;
  return note ? `${note}\n\n${body}` : body;
}

/**
 * Setup's line for a CLI it found (Behaviour 1): `claude 2.1.303 · /home/u/.local/bin/claude`,
 * then what a shim runs (`shimText`) when it is one.
 * @param {CliInfo} cli @param {string} stdout  of `--version` @param {string} path
 * @param {string} [shim]
 * @param {boolean} [late]  `--version` was killed after VERSION_MS: a CLI slow to start (its
 *   first start after an install, a busy machine) is told apart from one that printed no version
 */
export function versionText(cli, stdout, path, shim = "", late = false) {
  const first = plain(stdout.split("\n")[0]).trim();
  // Codex prints `codex-cli 0.163.0`; the line names the program already.
  const named = first.startsWith(`${cli.bin}-cli `) ? first.slice(cli.bin.length + 5) : first;
  const version = late
    ? `gave no version in ${VERSION_MS / 1000} s`
    : named.replace(/\s*\(.*\)\s*$/, "") || "unknown version";
  return `${cli.bin} ${cut(version, 40)} · ${path}${shim ? ` · ${shim}` : ""}`;
}

/**
 * The program a link named like the CLI resolves to, when that program picks the tool to run by
 * the name it is started as (C4): a version manager's dispatcher, such as mise, asdf's, volta's
 * or aqua's, whose shims are links named like each tool. Null when the file is the CLI itself:
 * named as the CLI is, named by a version (Claude Code's native installer keeps each version as
 * a file named by it), or named with an extension (npm's `cli.js`, a script its interpreter is
 * given by path). Only the name is read: a dispatcher runs correctly through its link, so the
 * rule only words setup's row and refuses a dispatcher stored without its link.
 * @param {CliInfo} cli @param {string} name  the resolved file's name
 * @returns {string | null}
 */
export function dispatcherOf(cli, name) {
  if (
    name === cli.bin ||
    /^v?\d+(\.\d+)*([-+][\w.]+)?$/.test(name) ||
    /\.[A-Za-z]\w*$/.test(name)
  ) {
    return null;
  }
  return name;
}

/**
 * What setup's row says of a shim (Behaviour 1): `a mise shim (runs /usr/bin/mise as claude)`.
 * @param {CliInfo} cli @param {string} name  of the dispatcher @param {string} real  its path
 */
export const shimText = (cli, name, real) =>
  `a ${cut(plain(name), 40)} shim (runs ${plain(real)} as ${cli.bin})`;

/**
 * Why a dispatcher stored without its link may not run (C4): started under its own name, it
 * cannot tell which tool to run, and fails on the CLI's arguments.
 * @param {CliInfo} cli @param {string} name  of the dispatcher
 */
export const dispatcherProblem = (cli, name) =>
  `it is ${plain(name)}, which runs ${cli.bin} only through a link named ${cli.bin}`;

/** Setup's row that finds a CLI again, as a refusal it can repair names it. */
export const FINDS_AGAIN = "add: agent CLI finds it again";

/**
 * A run refused before it started (C4), with the way to repair it when setup can: a program that
 * is gone (an upgrade removed the version a path named) or a dispatcher stored without its link.
 * @param {CliInfo} cli @param {string} path @param {string} problem  from the checks
 */
export function refusedText(cli, path, problem) {
  const repairable =
    problem === "it does not exist" || problem.endsWith(`only through a link named ${cli.bin}`);
  return `${cli.id} at ${path} is refused: ${problem}${repairable ? `; ${FINDS_AGAIN}` : ""}`;
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
 * tool of its own it reported, each cut, so a CLI's init can never make a line without bound;
 * a CLI that reports none (`null`, Codex) has its configuration named instead.
 * @param {CliInfo} cli @param {string} version @param {string} model
 * @param {string[] | null} tools
 */
export function runStartedText(cli, version, model, tools) {
  const head = [`${cli.id}${version ? ` ${cut(plain(version), 40)}` : ""}`];
  head.push(model ? cut(plain(model), 80) : "its default model");
  return `run started: ${head.join(" · ")} · its own tools: ${runTools(tools)}`;
}

/** @param {string[] | null} tools */
function runTools(tools) {
  if (!tools) return ownToolsText(null);
  const names = tools.slice(0, RUN_TOOLS).map((t) => cut(plain(t).replace(/\s+/g, " "), 24));
  const more = tools.length > RUN_TOOLS ? ` +${tools.length - RUN_TOOLS}` : "";
  return `${names.length ? names.join(", ") : "none"}${more}`;
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
  // Codex's items, named by the tools that make them.
  shell: "command",
  apply_patch: "files",
  // Gemini CLI's tools.
  run_shell_command: "command",
  read_file: "file_path",
  write_file: "file_path",
  replace: "file_path",
  list_directory: "dir_path",
  glob: "pattern",
  grep_search: "pattern",
  google_web_search: "query",
  web_fetch: "prompt",
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
 * of its error output, or of its result's error, cut at 200 characters. `ran`, the program
 * started, is named when the CLI printed nothing on its output: it did not start as the CLI,
 * and the program is the first thing to look at.
 * @param {CliInfo} cli @param {number | null} code @param {string} stderr  its last 4 KB
 * @param {string} [error]  the result's error, when the CLI reported one
 * @param {string} [ran]
 */
export function exitText(cli, code, stderr, error = "", ran = "") {
  const lines = [error, ...stderr.split("\n").reverse()]
    .map((l) => plain(l).trim())
    .filter(Boolean);
  const head = `${cli.id}${ran ? ` at ${plain(ran)}` : ""} exited (${code ?? "?"})`;
  return cut(lines.length ? `${head}: ${lines[0]}` : head);
}

/**
 * The program's path checks before each run (C4), from what the browser read of the file:
 * a file another local user can replace would run that user's code as this user.
 * @param {{ absolute: boolean, regular: boolean, executable: boolean,
 *   owner: "user" | "root" | "other", othersWrite: boolean, dirOwner: "user" | "root" | "other",
 *   dirOthersWrite: boolean, linkOwner?: "user" | "root" | "other" }} f  `othersWrite`: group
 *   or others may write it; `dirOwner` and `dirOthersWrite`: every folder the path passes
 *   through, the links' folders included; `linkOwner`: any link on the way, "other" if one is
 *   another user's (a link's own mode means nothing; its folder and owner decide who repoints it)
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
  if (f.linkOwner === "other") return "a link on its path is owned by another user";
  return null;
}

/**
 * The folders and links to judge for vimma-ctl beside Vimma's binary (M56). The folders on the
 * way to the binary, and the links in them, are skipped: whoever can swap one can already change
 * Vimma itself, and macOS's /Applications is writable by the admin group. That holds only for a
 * file in the binary's own folder, and only for those folders: a link through any other folder
 * is followed again by the kernel at each run, so that folder and that link are judged even when
 * the chain ends beside the binary. Without `trusted`, or for a file elsewhere, all are judged.
 * @param {{ realDir: string | null, dirs: Iterable<string>,
 *   links: Iterable<{ dir: string, owner: "user" | "root" | "other" }> }} walk  the path as it
 *   resolved: the folder of the file it ends at, every folder an entry was looked up in, and
 *   every link with its folder and owner
 * @param {{ binDir: string, dirs: Iterable<string> } | null} trusted  the binary's real folder,
 *   and every folder looked up on the way to it
 * @returns {{ dirs: string[], linkOwner: "user" | "other" }}
 */
export function besideBinary(walk, trusted) {
  const skip =
    trusted && walk.realDir === trusted.binDir
      ? new Set([...trusted.dirs, trusted.binDir])
      : new Set();
  const dirs = [...walk.dirs].filter((d) => !skip.has(d));
  const links = [...walk.links].filter((l) => !skip.has(l.dir));
  return { dirs, linkOwner: links.some((l) => l.owner === "other") ? "other" : "user" };
}

/**
 * @typedef {{ type: "init", model: string, version: string, tools: string[] | null }
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
 *   lines written during this one. `fail` ends the run. `tools` is null for a CLI that does not
 *   report its own (C7).
 */

const CLAUDE = /** @type {CliInfo} */ (CLIS["claude-code"]);

/** @param {unknown} v @returns {v is Record<string, any>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const count = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
/**
 * A usage block's input tokens, cache creation and reads included, as the Messages API
 * provider counts them: Claude Code caches its prompt, so most of a call's input is cached.
 * Null when it reports none. @param {Record<string, any> | undefined} u
 */
const inputTokens = (u) => {
  const parts = [u?.input_tokens, u?.cache_creation_input_tokens, u?.cache_read_input_tokens]
    .map(count)
    .filter((n) => n !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
};

/**
 * A CLI's stdout read as JSON lines (C8): `push` takes it as it comes, `end` once it closed. A
 * `fail` event ends the run, after which nothing more is read. A line that is not a JSON object
 * is ignored and counted; each CLI's class reads the objects (`event`).
 */
class JsonLines {
  /** @param {CliInfo} cli */
  constructor(cli) {
    this.cli = cli;
    this.buffer = "";
    this.total = 0;
    this.ignored = 0;
    this.failed = false;
  }

  /** @param {string} chunk @returns {CliEvent[]} */
  push(chunk) {
    if (this.failed) return [];
    this.total += chunk.length;
    if (this.total > CLI_STREAM_LIMITS.total) {
      return this.fail(`${this.cli.id} wrote over 64 MiB`);
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
    return `${this.cli.id} wrote a line over 1 MiB`;
  }

  /** @protected @param {string} error @returns {CliEvent[]} */
  fail(error) {
    this.failed = true;
    this.buffer = "";
    return [{ type: "fail", error }];
  }

  /** @protected @param {string} [version] */
  unreadable(version) {
    const v = version ? ` ${version}` : "";
    return this.fail(`${this.cli.id}${v} speaks a stream Vimma does not read`);
  }

  /** @protected */
  skip() {
    this.ignored++;
    return [];
  }

  /** @private @param {string} line @returns {CliEvent[]} */
  line(line) {
    if (!line.trim()) return [];
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return this.skip();
    }
    return isObject(m) ? this.event(m) : this.skip();
  }

  /**
   * One JSON object of the stream, read by each CLI's class.
   * @protected @abstract @param {Record<string, any>} m @returns {CliEvent[]}
   */
  event(m) {
    throw new Error(`${this.cli.id}: no reader for ${typeof m}`);
  }
}

/**
 * Claude Code's `stream-json` output read as the transcript's entries (C8). An event it does
 * not know is ignored and counted.
 */
export class ClaudeStream extends JsonLines {
  constructor() {
    super(CLAUDE);
    /** @type {string | null} the version from the init, for a stream that stops parsing */
    this.version = null;
    /** Model calls whose usage was reported, by message id: each repeats it per block. */
    this.calls = new Set();
    /** What this turn's calls reported so far. */
    this.turn = { input: 0, output: 0 };
  }

  /** @protected @param {Record<string, any>} m @returns {CliEvent[]} */
  event(m) {
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
      return this.unreadable(this.version ?? "");
    }
    const vimma = servers.find((s) => isObject(s) && s.name === MCP_SERVER);
    if (!vimma || vimma.status !== "connected") {
      return this.fail(`${this.cli.id} could not start vimma-ctl`);
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
      const input = inputTokens(usage) ?? 0;
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
      return this.unreadable(this.version ?? "");
    }
    const input = inputTokens(usage);
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

const CODEX = /** @type {CliInfo} */ (CLIS.codex);

/** A Codex usage block's tokens: its input counts the cached part already. */
const codexUsage = (/** @type {Record<string, any>} */ u) => ({
  input: count(u.input_tokens) ?? 0,
  output: count(u.output_tokens) ?? 0,
});

/**
 * Codex's `exec --json` output read as the transcript's entries (C8). Its run is one turn:
 * `thread.started` starts it, with no model, version or tool list, so the init has the
 * provider's model and no tools (the header then says its configuration decides, C7);
 * `turn.completed` and `turn.failed` are its result. Its `error` events are retries and
 * warnings, of which the last is the run's error when it ends without a result. A call to an
 * MCP server that is not Vimma's ends the run: the arguments turned every other server off, so
 * one that still answers came from somewhere Vimma did not see (C7).
 */
export class CodexStream extends JsonLines {
  /** @param {{ model?: string }} [o]  the provider's model, "" for Codex's own default */
  constructor({ model = "" } = {}) {
    super(CODEX);
    this.model = model;
    /** Own-tool items already shown, by id: an item is started, then completed. */
    this.shown = new Set();
    this.resulted = false;
    /** @type {string | null} */
    this.lastError = null;
  }

  /** @protected @param {Record<string, any>} m @returns {CliEvent[]} */
  event(m) {
    if (m.type === "thread.started") {
      return [{ type: "init", model: plain(this.model), version: "", tools: null }];
    }
    if (m.type === "item.started" || m.type === "item.completed") return this.item(m);
    if (m.type === "turn.completed") {
      if (m.usage !== undefined && !isObject(m.usage)) return this.unreadable();
      const usage = isObject(m.usage) ? codexUsage(m.usage) : null;
      return this.result({ ok: true, error: null, usage });
    }
    if (m.type === "turn.failed") {
      const message = isObject(m.error) ? m.error.message : null;
      const error = plain(typeof message === "string" && message ? message : "the turn failed");
      return this.result({ ok: false, error, usage: null });
    }
    if (m.type === "error" && typeof m.message === "string") this.lastError = plain(m.message);
    // turn.started, item.updated, retries, unknown events.
    return this.skip();
  }

  /** @returns {CliEvent[]} */
  end() {
    const out = super.end();
    if (this.failed || this.resulted || !this.lastError) return out;
    return [...out, ...this.result({ ok: false, error: this.lastError, usage: null })];
  }

  /**
   * @private
   * @param {{ ok: boolean, error: string | null, usage: { input: number, output: number } | null }} r
   * @returns {CliEvent[]}
   */
  result({ ok, error, usage }) {
    this.resulted = true;
    // No call reports its usage before the turn's end, so the turn's is all of it.
    return [{ type: "result", ok, error, usage, rest: usage, cost: null, queued: 0 }];
  }

  /** @private @param {Record<string, any>} m @returns {CliEvent[]} */
  item(m) {
    const item = m.item;
    if (!isObject(item)) return this.skip();
    const id = typeof item.id === "string" ? item.id : "";
    if (item.type === "mcp_tool_call") {
      // A step in the browser is the gate's to show, not the CLI's account of it (C8).
      if (item.server === CODEX_SERVER) return this.skip();
      return this.fail(
        `${CODEX.id} called an MCP server that is not Vimma's: ${cut(plain(item.server), 40)}`,
      );
    }
    if (item.type === "agent_message") {
      if (m.type !== "item.completed" || typeof item.text !== "string" || !item.text.trim()) {
        return this.skip();
      }
      return [{ type: "reply", text: item.text }];
    }
    const own =
      item.type === "command_execution"
        ? ownToolText(CODEX, "shell", { command: item.command })
        : item.type === "file_change" && Array.isArray(item.changes)
          ? ownToolText(CODEX, "apply_patch", { files: changedFiles(item.changes) })
          : null;
    // Reasoning, todo lists, warnings (an `error` item), unknown kinds.
    if (own === null || (id && this.shown.has(id))) return this.skip();
    if (id) this.shown.add(id);
    return [{ type: "own-tool", id, text: own }];
  }
}

/** A file change's files as its line names them: `add notes.txt, update a.md`. @param {unknown[]} changes */
function changedFiles(changes) {
  return changes
    .filter(isObject)
    .map((c) => `${plain(c.kind)} ${plain(c.path)}`.trim())
    .join(", ");
}

const GEMINI = /** @type {CliInfo} */ (CLIS.gemini);
/** Tool errors that mean Gemini CLI did not run the tool: not offered, or refused by policy. */
const GEMINI_REFUSED = new Set(["tool_not_registered", "policy_violation"]);

/**
 * Gemini CLI's `-o stream-json` output read as the transcript's entries (C8). Its run is one
 * turn: `init` starts it with no version, tool list or MCP server status, so the init has the
 * provider's model and no tools (the header then says its configuration decides, C7); `result`
 * ends it with its tokens, its last turn and its router's request included, and no cost. A reply
 * comes as pieces (`delta`), joined until the next event. A server that did not start is not in
 * the stream (Research): the run goes on without Vimma's tools. A tool of an MCP server that is
 * not Vimma's that ran ends the run, as for Codex; a call to one never offered (the model's own
 * guess at a name) comes back refused, as any tool it was not given.
 */
export class GeminiStream extends JsonLines {
  /** @param {{ model?: string }} [o]  the provider's model, "" for Gemini CLI's own default */
  constructor({ model = "" } = {}) {
    super(GEMINI);
    this.model = model;
    /** The reply's pieces so far. */
    this.text = "";
    /** Tool calls by id: what each one was, for its result. @type {Map<string, string>} */
    this.calls = new Map();
    this.resulted = false;
    /** @type {string | null} */
    this.lastError = null;
  }

  /** @protected @param {Record<string, any>} m @returns {CliEvent[]} */
  event(m) {
    if (m.type === "message" && m.role === "assistant" && typeof m.content === "string") {
      this.text += m.content;
      return [];
    }
    const out = this.reply();
    if (m.type === "init") {
      out.push({ type: "init", model: plain(this.model), version: "", tools: null });
    } else if (m.type === "tool_use") out.push(...this.use(m));
    else if (m.type === "tool_result") out.push(...this.toolResult(m));
    else if (m.type === "result") out.push(...this.result(m));
    else {
      if (m.type === "error" && typeof m.message === "string") this.lastError = plain(m.message);
      // The task echoed back (`message` of the user), warnings, unknown events.
      this.skip();
    }
    return out;
  }

  /** @returns {CliEvent[]} */
  end() {
    const out = [...super.end()];
    if (this.failed) return out;
    out.push(...this.reply());
    if (this.resulted || !this.lastError) return out;
    this.resulted = true;
    return [...out, ...this.ended(false, this.lastError, null)];
  }

  /** @private @returns {CliEvent[]} */
  reply() {
    const text = this.text;
    this.text = "";
    return text.trim() ? [{ type: "reply", text }] : [];
  }

  /** @private @param {Record<string, any>} m @returns {CliEvent[]} */
  use(m) {
    if (typeof m.tool_name !== "string") return this.skip();
    const name = m.tool_name;
    const id = typeof m.tool_id === "string" ? m.tool_id : "";
    if (id) this.calls.set(id, name);
    // A step in the browser is the gate's to show, not the CLI's account of it (C8).
    if (name.startsWith(`mcp_${GEMINI_SERVER}_`)) return this.skip();
    return [{ type: "own-tool", id, text: ownToolText(GEMINI, name, m.parameters) }];
  }

  /** @private @param {Record<string, any>} m @returns {CliEvent[]} */
  toolResult(m) {
    const id = typeof m.tool_id === "string" ? m.tool_id : "";
    const name = this.calls.get(id);
    if (name === undefined || name.startsWith(`mcp_${GEMINI_SERVER}_`)) return this.skip();
    const kind = isObject(m.error) ? m.error.type : null;
    const refused = m.status === "error" && GEMINI_REFUSED.has(kind);
    if (refused) return [{ type: "own-tool-refused", id }];
    if (name.startsWith("mcp_")) {
      return this.fail(
        `${GEMINI.id} called an MCP server that is not Vimma's: ${cut(plain(name), 40)}`,
      );
    }
    return this.skip();
  }

  /** @private @param {Record<string, any>} m @returns {CliEvent[]} */
  result(m) {
    const stats = m.stats;
    if (
      (m.status !== "success" && m.status !== "error") ||
      (stats !== undefined && !isObject(stats))
    ) {
      return this.unreadable();
    }
    this.resulted = true;
    const input = count(stats?.input_tokens);
    const output = count(stats?.output_tokens);
    const usage =
      input === null && output === null ? null : { input: input ?? 0, output: output ?? 0 };
    if (m.status === "success") return this.ended(true, null, usage);
    const message = isObject(m.error) ? m.error.message : null;
    const error = plain(typeof message === "string" && message ? message : "the run failed");
    return this.ended(false, error, usage);
  }

  /**
   * @private @param {boolean} ok @param {string | null} error
   * @param {{ input: number, output: number } | null} usage
   * @returns {CliEvent[]}
   */
  ended(ok, error, usage) {
    // No call reports its usage before the run's end, so the result's is all of it.
    return [{ type: "result", ok, error, usage, rest: usage, cost: null, queued: 0 }];
  }
}
