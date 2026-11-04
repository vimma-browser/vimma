# Spec: builtin-agent-cli

Status: implemented · Area: `packages/vimma-core/src/` (new `agent-cli.mjs`:
argument builders and stream parsers per CLI; `config.mjs` for `kind = "cli"`; `control.mjs` for
the ticket hello);
`src/browser/base/content/vimma/` (new `agent/AgentCli.sys.mjs`: the process runner;
`agent/AgentChat.sys.mjs`, `ui/agent-chat.mjs` for setup and the header; `ctl/VimmaControl.sys.mjs`
and `ctl/agent-commands.mjs` for ticket connections); `tools/vimma-ctl` (`src/mcp_serve.rs`,
`src/discovery.rs`: connecting with a ticket); `docs/guide.md`, `docs/security.md`,
`docs/limits.md` · Upstream patches: none · ADR: an amendment to
[ADR-023](../adr/023-in-browser-model-client.md) (C1). No new dependency.

Issue: [#609](https://github.com/vimma-browser/vimma/issues/609)

Builds on [builtin-agent](builtin-agent.md) (the chat window, conversations, budgets and the
conversation grant), [vimma-mcp](vimma-mcp.md) (the agent workspace, the gate, the control
socket's agent role), [mcp-session-grants](mcp-session-grants.md) (a connection's grant and its
session id) and [mcp-checkpoints](mcp-checkpoints.md). Decisions of those specs are written
"builtin-agent B18", "vimma-mcp 7" and so on; this spec's own are "C1", "C2", and so on. Rules
of `docs/security.md` are written by their numbers there (S1, C2, F3, M35). Engine paths are
relative to `engine/` (Firefox 158.0.1, `config/milestone.txt`). Vimma paths are under
`src/browser/base/content/vimma/` unless they start with `packages/`, `tools/` or `docs/`; they
were read at commit `43c2e348`.

## Summary

The built-in agent's chat window gains a third kind of provider: an agent CLI the user already
has, such as Claude Code or Codex, run by Vimma without a terminal. The user writes the task in
the window as with any provider; Vimma starts the CLI headless with its streamed JSON output,
gives it Vimma's tools through `vimma-ctl mcp` bound to the conversation's own gate connection,
and shows the CLI's replies and steps in the transcript. The CLI keeps its own login, model and
billing, so a user with a Claude or ChatGPT plan can use it without an API key, while the
browser stays confined exactly as for the built-in agent: the agent workspace, the conversation
grant, the checkpoints and the step budget. The CLI also keeps the shell, file and web tools its
own configuration allows; Vimma does not confine them, and the window states which are enabled.

## Problem

- **Users already have an agent.** Many users pay for and have set up Claude Code, Codex,
  Gemini CLI or opencode. To use one with Vimma today they run it in a terminal with
  `vimma-ctl mcp` configured, turn on `:mcp on`, and write the task in the terminal, away from
  the browser that does the work (guide, "Connecting an agent's tool"). The built-in agent's
  window needs a model API key or a local model instead, which those users do not have or do not
  want to pay for twice.
- **Their plan does not come with an API key.** A Claude subscription is used through Claude
  Code's own login; the window's Anthropic provider needs a separate, separately billed API key.
- **An MCP agent in a terminal is confined, but not by the conversation grant.** Its first step
  asks on the question line and its grant lasts its connection (mcp-session-grants), so a task
  the user has just written in the terminal is asked about again, which is what builtin-agent
  B18 removes for tasks sent from Vimma's window.
- **The CLI's own tools are invisible from the browser.** A coding CLI has a shell, file tools
  and web fetching of its own. When it runs in a terminal, nothing in Vimma says so, and the
  user has to know which of the CLI's permission settings apply to a browser task.

## Behaviour

### Setup

1. **A third choice in setup.** Setup (builtin-agent Behaviour 1) offers `agent CLI` beside
   `local model` and `external provider`. It lists the supported CLIs that a search of `PATH`
   finds (`claude`, then `codex`), each with its absolute path and the version it prints
   (`claude 2.1.303 · /home/u/.local/bin/claude`), and the user picks one with `Enter`. The
   search and the version call run only while setup is open with this choice picked, never in
   the background. When none is found, setup says which names it looked for and that the CLI
   has to be installed and logged in first. The path listed is the one `PATH` holds, links
   included. When it is a version manager's shim, a link named as the CLI to a program that
   picks the tool by the name it is started as (C4), the row's detail says so
   (`agent CLI (mise shim)`, since a narrow window cuts the label's path) and its label reads
   `claude 2.1.314 · /home/u/.local/share/mise/shims/claude · a mise shim (runs /usr/bin/mise as claude)`,
   and a `PATH` entry that is not a shim is listed instead when there is one, because it runs
   the CLI without one more program in between. A shim stays listed when it is all `PATH` has,
   because running its link works.
2. **The path is confirmed, not configured.** Picking a CLI stores its absolute path, as setup
   listed it, in the pref `vimma.agent.cli.<name>.path` (C4). `config.toml` may list a CLI provider by name and model
   only:

   ```toml
   [[agent.providers]]
   name = "claude"
   kind = "cli"
   cli = "claude-code"      # "claude-code" or "codex"
   model = "sonnet"         # optional: passed as the CLI's own model option
   max_minutes = 30         # optional: wall-clock limit of one task (C10)
   ```

   A `command`, `path`, `args` or `env` field in a CLI provider is a config error, reported with
   its line, and the provider is not used (C4, C5).

   (Since changed: a `cli` value this build does not know is a warning, not an error: that
   provider is skipped, the status bar names its line, and the rest of the file applies, because
   a file written by a newer build, or shared in dotfiles between versions, otherwise fell back to
   the defaults whole. A `default` that names a skipped provider sets none. Issue #742.)

   Picking a CLI that `config.toml` does not list yet asks for its model on the prompt line,
   `agent model: `, as setup does for a hosted provider, with the CLI's suggested model filled in
   (`sonnet` for Claude Code, from `CLIS` in `agent-cli.mjs`). The model is the user's choice
   at setup, and a hand edit of `config.toml` should not be the only way to make it. Empty
   input leaves the choice to the CLI's own default model, which the notice says
   (`agent: claude · Claude Code's own default model · saved to config.toml`). A model that
   starts with `-`, holds any control character (a tab or a line break included) or is longer
   than 200 characters, the most `config.toml` takes, is refused there and asked again, by the rule
   the command line applies (C2), so it never fails at a task's start or when it is saved; `config.toml` reports
   such a model as an error with its line. The path pref is written only once a model is
   taken, and the provider goes to `config.toml` with its name, kind, CLI and model. Picking a
   CLI that `config.toml` already lists uses that provider and asks nothing; its model is then
   chosen in the picker (Behaviour 17).

3. **Choosing starts nothing.** Picking a CLI provider starts no process but the version call
   of item 1. The CLI runs only when the user sends a task.
4. **The first task says where data goes and what the CLI may do.** Before the first task of a
   conversation with a CLI provider (and again after a provider change), the window shows, and
   needs a `y` to:
   `Page text the agent reads, field values it sees, screenshots and your messages go to Claude Code, which sends them to the model it is set up for. Claude Code also keeps the tools its own settings allow (shell, files, web); Vimma does not confine them. y send · n cancel`.
5. **The header says it too.** The header's first line names the CLI, its model when the CLI
   reports one, and where data goes:
   `claude-code · claude-sonnet-4-5 · sent where Claude Code sends it`. The second line states,
   next to where the agent works, which of the CLI's own tools are enabled for the task, as the
   CLI reported them when the run started (C7):
   `works in: agent workspace · granted · its own tools: Bash, Read, Write, WebFetch +3`.
   A CLI that reports no tool of its own shows `its own tools: none`; before its first run, and
   for a CLI that does not report its tools (Codex), the line says
   `its own tools: as its configuration allows`. The transcript's run-started line lists the
   reported tools in full.
6. **`local_only` refuses a CLI.** With `[agent] local_only = true`, a CLI provider is refused in
   setup, in the picker and at each task, with
   `an agent CLI may send page text off this machine ([agent] local_only)` (C11).

### Running a task

7. **A task is one run of the CLI.** Sending a task starts the CLI with the arguments of C2,
   with no shell, in a new empty working directory (C6). The transcript shows the user's
   message, then the CLI's replies and steps as they stream in (C8). The task ends when the CLI
   reports its result and exits; the working directory is then removed.
8. **The CLI reaches the browser only through the conversation's gate connection.** Its only
   tools that act on pages are the agent tools of `vimma-ctl mcp`, and they act as the
   conversation, on its tabs, under its grant (C1, C3). The step lines in the transcript come
   from the gate, in the words of the step's notice, as for any provider (builtin-agent
   Behaviour 12).
9. **The CLI's own tool steps are shown and marked.** A step the CLI takes with a tool of its
   own (a shell command, a file read or write, a web fetch) is a transcript line of its own,
   `◆ claude-code ran its own tool: Bash "ls ~/Downloads"`, cut at 200 characters, in the
   muted colour, so it is never mistaken for a step in the browser. Vimma shows it; it does not
   approve or refuse it, and the gate never sees it (C7).
10. **Added instructions.** A message sent while a Claude Code task runs is written to the CLI's
    input at once and reaches the model no later than its next turn, marked
    `(added during the task)` (builtin-agent Behaviour 15). For a CLI without a live input
    (Codex), the message waits and starts the next run when the current one ends, marked
    `(sent after the running task)`; several such messages start one run together. A task that
    ends other than done (stopped, failed or over a budget) starts no run: the transcript says
    `the message sent after the running task not sent: the task was stopped` (or `failed`,
    `met a limit`), and the user sends it again if it still applies.
11. **Stopping.** `s`, `:agent stop` and `ctrl+b shift+a` end the conversation's grant and
    close its gate connection in the browser first, then stop the CLI: `SIGTERM`, then
    `SIGKILL` after 3 s (C9). The transcript says `stopped`. Nothing the CLI does after the stop
    reaches the browser.
12. **A later task starts a new run with the stored conversation.** Each task is a new process
    given the conversation's stored messages, replies and summaries (builtin-agent
    Behaviour 20-21) before the new message, so a CLI keeps no session of its own between tasks
    (C5). The task's text starts with the CLI's `note` from `CLIS` (one sentence for every CLI
    so far): web searches and reading pages go through Vimma's tools in the agent workspace,
    for example a search engine's results page opened with `vimma_open`, and tools of its own
    not allowed in advance are refused. The run allows only Vimma's tools (C2, C7), so the CLI's
    own web search is refused unless its settings allow it, and a model that meets that refusal
    tends to stop the task; told first, it searches through the agent workspace, under the
    gate's questions and grants. A CLI that needs other words gets its own `note`.
13. **Errors.** A CLI that is missing, not executable, not logged in, or exits before its result
    ends the task with a transcript line naming the CLI, its exit code and the last line of its
    error output, cut at 200 characters:
    `claude-code exited (1): Invalid API key · Please run /login`. When the CLI printed nothing
    on its output, the line also names the program that ran
    (`claude-code at /usr/bin/mise exited (2): For more information, try '--help'.`), because
    the program then most likely never started as the CLI, and its path is the first thing to
    check.

### Budgets and cost

14. **Steps are counted by the gate.** `[agent] max_steps` counts the conversation's calls that
    reach the gate, whatever the CLI reports; at the limit the gate refuses the connection's
    next call and the task stops as in Behaviour 11 (C10). The CLI's own tool steps
    (Behaviour 9) do not count, since they never reach the gate.
15. **Tokens are the CLI's report; cost is shown, not enforced.** When the CLI reports tokens
    (Claude Code's `result.usage`, Codex's `turn.completed.usage`), they count toward
    `max_tokens` and show in the status bar as for any provider. When it reports a cost (Claude
    Code's `total_cost_usd`), the status bar shows it as `≈ $0.41 (claude-code)` while the task
    runs, the task's end line keeps it as `done · ≈ $0.41 (claude-code estimate)`, and
    `max_cost` does not apply to it (C13); the first task of a conversation with a CLI says
    `max_cost does not apply to claude-code: the cost it reports is its own estimate`, since
    `max_cost` always has a value (2 unless set). When the CLI reports neither, the status bar shows
    steps and time only (`◇ built-in 14/100 · 6 min`) and the transcript's task summary says
    `tokens not reported by codex`.
16. **A time limit.** A CLI task stops after `max_minutes` of wall-clock time (default 30), with
    `stopped: 30 minutes, the limit of max_minutes`, because a CLI can spend time and money on
    its own tools without a single step Vimma counts (C10).

### Choosing the model

17. **A CLI's models are in the picker.** For each agent CLI that `config.toml` lists, the
    model picker (builtin-agent Behaviour 7) lists one row per model of the CLI's in `CLIS`
    (`agent-cli.mjs`; Claude Code: `sonnet`, `opus`, `haiku` and its own default), under the
    name of the CLI's first provider (`claude · opus`), after the configured providers, and a
    row `claude · other model…` that asks for a model on the prompt line under Behaviour 2's
    rule. The model `config.toml` names is marked `config.toml`, the conversation's
    `in use`. `Enter` uses a row's model for the open conversation and this session's new ones
    until a restart, and `D` adds it to `config.toml` as a provider of its own, with the CLI
    provider's `max_minutes` when that is not the default, and makes it `[agent] default`, as
    for any model in the picker (builtin-agent B12). A running task keeps
    its model. The list is Vimma's own and starts no process: the CLI is not asked for its
    models (Behaviour 3). Choosing the model belongs in the window, as every other provider's
    does, because a hand edit of `config.toml` should not be the only way to change it after
    setup, and Claude Code's aliases name its newest model of each family, so the list stays
    current between releases; a model the CLI no longer takes fails at the task's start with
    the CLI's own error (Behaviour 13).

## Research

### Vimma at `43c2e348`

- `ctl/AgentDownloads.sys.mjs:674`: the only `Subprocess.call` in Vimma, which starts the
  system's ClamAV scanner with a fixed path, fixed argument builders, `stderr: "pipe"` and a
  time limit after which the process is killed (`proc.kill()`). `docs/security.md` C2 allows
  chrome code to start a process only for that scanner and an AppImage's restart; this feature
  is a third exception.
- `docs/security.md` F3: the config is never executed, "no value is evaluated as code or run as
  a command". A program path in `config.toml` would break it (C4).
- `docs/security.md` S1, S12: the control socket listens only while `vimma.control.enabled` or
  `vimma.mcp.enabled` is on, and the agent role runs only with MCP on. M35: the built-in agent
  acts through `runAgentCommand` on one connection per conversation (`builtin:<n>`) and works
  with MCP off.
- `tools/vimma-ctl/src/mcp_serve.rs:297-329`: `vimma-ctl mcp` opens its agent connection with the
  discovery file's token and sends a random session id in `agent-hello` (`:112`, `:325`), so a
  reconnect keeps its grant (mcp-session-grants).

### Firefox 158.0.1: starting a process

- `toolkit/modules/subprocess/Subprocess.sys.mjs:50-150`: `Subprocess.call` takes an absolute
  `command` ("Relative paths are not accepted, and `$PATH` is not searched", `:55-57`), an
  `arguments` array, an `environment` object that is the whole environment unless
  `environmentAppend` is set (`:65-75`, `:117-127`), `stderr` (`ignore`, `stdout` or `pipe`,
  `:77-83`) and `workdir` (`:85`). It refuses a file that is not executable (`:135-143`). There
  is no shell. `Subprocess.pathSearch` (`:183`) maps a bare name to a path.
- `toolkit/modules/subprocess/subprocess_common.sys.mjs:670-700`: `kill(timeout)` sends `SIGTERM`
  and, if the process has not exited after `timeout` ms (default 300), `SIGKILL`.
- `toolkit/modules/subprocess/subprocess_unix.worker.js:314-317`: the signal goes to the
  process's own pid (`libc.kill(this.pid, signal)`), not to a process group; `spawn` (`:379-416`)
  launches through `IOUtils.launchProcess` and maps only the three standard descriptors. A
  child the CLI started (a shell command, its MCP server) is therefore not signalled by Vimma
  and ends only if the CLI ends it or its pipes close.
- `toolkit/components/extensions/NativeMessaging.sys.mjs:29-46`, `:420-465`: native messaging,
  Firefox's own case of starting a local program and speaking to it over stdio, gives the
  program 3,000 ms (`GRACEFUL_SHUTDOWN_TIME`) to exit before a forced kill.

### The CLIs

Each CLI was checked as stated; none was run against a real account, and no tokens were spent.

- **Claude Code 2.1.303.** `claude --help`, and two runs of
  `claude -p --bare --output-format stream-json --verbose` against a scripted Anthropic Messages
  server on 127.0.0.1 (`ANTHROPIC_BASE_URL`, a made-up key, a throwaway `HOME`) with a
  one-tool MCP server named `vimma`:
  - Options used: `-p`; `--output-format stream-json` with `--verbose`;
    `--input-format stream-json` ("realtime streaming input"); `--mcp-config` (files or
    strings) with `--strict-mcp-config` ("Only use MCP servers from --mcp-config"); `--tools ""`
    ("disable all tools" of the built-in set); `--allowedTools`; `--permission-mode dontAsk`;
    `--max-budget-usd` ("only works with --print"); `--no-session-persistence`; `--model`;
    `--bare` (skips hooks, plugins and the discovery of project instruction files; its Anthropic auth is
    `ANTHROPIC_API_KEY` or an `apiKeyHelper` only, "OAuth and keychain are never read"). `-p`
    skips the workspace trust dialog ("Only use this in directories you trust").
  - Output, one JSON object a line: `{"type":"system","subtype":"init"}` with `tools`,
    `mcp_servers` (`[{"name":"vimma","status":"connected"}]`, or `"failed"` when the server did
    not start), `model` and `permissionMode`; `{"type":"assistant","message":{"content":[…]}}`
    whose blocks are `text` or `tool_use` (`name` `mcp__vimma__vimma_tabs`, `input`);
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":…}]}}`; and
    `{"type":"result","subtype":"success","is_error":false,"result":…}` with `num_turns`,
    `total_cost_usd`, `usage` (`input_tokens`, `output_tokens`) and `permission_denials`.
    Other `system` subtypes appeared (`ui_invalidate`). With `--tools ""` the init's `tools`
    held only the MCP tool, and with `--allowedTools mcp__vimma__vimma_tabs` and `dontAsk` the
    call ran without a prompt.
  - With `--input-format stream-json`, two user lines
    (`{"type":"user","message":{"role":"user","content":"…"}}`) written to stdin three seconds
    apart gave two `result` lines from one process, which exited when stdin closed. A line
    written while a turn was running reached that turn: Claude Code's next request to the
    scripted server carried it as "The user sent a new message while you were working", and the
    run gave one `result`, whose `queued_turn_count` was 0. A line that comes too late for the
    turn is queued for another, which that count reports.
  - Without `--bare`, with the arguments of C2 and the model `sonnet`, a run against the same
    scripted server (a made-up key in `ANTHROPIC_API_KEY`, a throwaway `HOME`) gave the stream
    recorded in `packages/vimma-core/test/fixtures/agent-cli/`. The init's `tools` listed the
    CLI's default set (`Bash`, `Read`, `Write`, `WebFetch` and others) and
    `mcp__vimma__vimma_tabs`; a `Bash` call the settings did not allow came back as a
    `system`/`permission_denied` event naming its `tool_use_id`. With a key the server refused
    (401), the CLI retried ten times (`system`/`api_retry`), then wrote an `assistant` message
    of the model `<synthetic>` with a top-level `error` repeating the error, a `result` with
    `is_error: true` and that text, and exited with 1, with nothing on stderr. The throwaway
    `HOME` then held `.claude.json`, its backup and the MCP server's log, and no session file.
  - `total_cost_usd` is computed by Claude Code (the run reported `"costBasis":"list"`), not
    returned by the API: for a subscription it is not what the user pays.
- **Codex 0.163.0.** `codex --help`, `codex exec --help` and `codex mcp add --help`, and the
  event names in the binary's strings; not run. `codex exec` takes the prompt as an argument or
  from stdin and has `--json` ("Print events to stdout as JSONL"), `--ephemeral` ("Run without
  persisting session files to disk"), `-s, --sandbox` (`read-only`, `workspace-write`,
  `danger-full-access`) for "model-generated shell commands", `-C, --cd`, `-m, --model`,
  `--skip-git-repo-check`, `-c key=value` overrides of `~/.codex/config.toml`, and
  `exec resume`. The binary holds the event names `thread.started`, `turn.started`,
  `turn.completed`, `turn.failed`, `item.started`, `item.updated`, `item.completed`, the item
  kinds `agent_message`, `mcp_tool_call`, `command_execution`, `file_change`, `todo_list`, and
  the usage fields `cached_input_tokens` and `reasoning_output_tokens`. No option that turns the
  shell off was found. No cost field was found.
  - Run (Delivery 3) against a scripted Responses server (a `model_provider` with a made-up
    key, a throwaway `HOME`), with the arguments of C2 and the task on stdin, which it reads to
    its end before it starts: the streams recorded in `packages/vimma-core/test/fixtures/agent-cli/`.
    `thread.started` carries only a `thread_id`: no model, version, tool list or sandbox, so
    the header cannot name Codex's effective sandbox (C7). An MCP call is an `mcp_tool_call`
    item naming its `server`; a shell command a `command_execution` item; a patch a
    `file_change` item with its paths; `turn.completed.usage` has `input_tokens` (with
    `cached_input_tokens` among them) and `output_tokens`, and no cost. A refused key gave
    `error` events (retries), then `turn.failed`, and exit 1. `--ephemeral` kept no prompt or
    reply in `CODEX_HOME`, which still received its state database.
  - A `-c mcp_servers.<name>={…}` table merges with a server of that name in `config.toml`
    (the user's `enabled_tools` stayed), so Vimma's server has a name of its own,
    `vimma_chat`, and a name in `codex mcp list --json` equal to it refuses the run. `-c
mcp_servers.<name>.enabled=false` turns a configured server off; `--disable <feature>`
    fails on a feature the version does not know, while `-c features.<name>=false` is
    ignored, so Vimma's arguments use `--disable`, and a version that renames a feature ends
    the run instead of keeping it on. `codex features list` showed `apps` and `plugins`, which
    bring MCP servers of their own, and `skill_mcp_dependency_install`, which adds a skill's MCP
    server to `config.toml` during a run, all on by default. `env_vars` passes the named variables of Codex's own environment to the server,
    and `default_tools_approval_mode="approve"` is needed for its calls to run under the
    `never` approval policy of `exec`; with `required=true`, a server that does not start ends
    the run with exit 1 and `required MCP servers failed to initialize` on stderr.
  - Codex's shell commands inherit its environment, `VIMMA_AGENT_TICKET` included;
    `-c shell_environment_policy.set.<name>=""` sets a variable empty for them and merges into
    the user's `set`, while `exclude` would replace the user's list.
- **Gemini CLI 0.66.0.** `gemini --help` and its bundle; not run. `-p` runs headless,
  `-o, --output-format stream-json`, `--approval-mode` (`default`, `auto_edit`, `yolo`, `plan`),
  `--allowed-mcp-server-names`, `--policy`, `-m`. The bundle's `JsonStreamEventType` has `init`,
  `message`, `tool_use`, `tool_result`, `error` and `result`. No option to keep no session files
  was found.
- **opencode 2.0.32.** `opencode run --help` only: `--format json`, `--model`, `--auto`
  ("Auto-approve permissions that are not explicitly denied"). Its event shape was not found in
  the binary and is not described here.
  - Run (issue #727) against a scripted OpenAI-compatible chat-completions server on 127.0.0.1
    (a provider of the `@ai-sdk/openai-compatible` kind with a made-up key, a throwaway `HOME`
    and XDG folders, in a network namespace that has only loopback), with a one-tool MCP server
    named `vimma` and the task on stdin. `run` reads stdin to its end before it starts
    (`text(process.stdin)` in its bundle), so it has no live input for added instructions
    (Behaviour 10). Without `--standalone`, `run` hands the task to opencode's background
    service (`opencode service`), which keeps the configuration and environment it started
    with, so a run's own MCP configuration does not reach it; `--standalone` starts a private
    server for the run (`opencode serve --stdio --port 0`).
  - Output with `--format json`, one JSON object a line, each with `type`, `timestamp`,
    `sessionID` and `part`: `step_start`; `tool_use`, once per finished call, with `part.tool`
    and `part.state` (`status` `completed` or `error`, `input`, `output` or `error`);
    `step_finish` with `part.tokens` (`input`, `output`, `reasoning`, `cache.read`,
    `cache.write`) and `part.cost`; `text` with `part.text`; `reasoning` only with
    `--thinking`; and `error` with `error.type` and `error.message` (a refused key:
    `provider.auth`, `Incorrect API key provided`, exit 1).
    No event names the model, the version or the run's tools, so the header cannot list its own
    tools (C7). In every recorded run, the last step, the one that writes the reply, had no
    `step_start` or `step_finish`, so its tokens and cost are not reported (C10, C13).
  - MCP tools are reached only through `execute` ("Code Mode"): a tool that runs JavaScript,
    with `fetch`, calling `tools.<server>.<tool>`. A call to Vimma's server is an `execute`
    `tool_use` whose `metadata.metadata.toolCalls` names `vimma.vimma_tabs`. The catalog of MCP
    tools is built when a step starts: with a server that took 1.5 s to start, the first step
    listed none of Vimma's tools and its `execute` call returned
    `Unknown tool 'vimma.vimma_tabs'`; the tools arrived in a later step as a `<system-update>`
    message. Setting `mcp.timeout.catalog` did not change that.
  - A run merges a system folder (`/etc/opencode`), the global folder
    (`$XDG_CONFIG_HOME/opencode`, replaced by `OPENCODE_CONFIG_DIR` when set), the file
    `OPENCODE_CONFIG` names, project files in and above the working directory, and
    `OPENCODE_CONFIG_CONTENT`. A server of the global configuration stayed in the run with
    `"enabled": false` under its name in `OPENCODE_CONFIG` or `OPENCODE_CONFIG_CONTENT` (the log
    says "omitted enabled-only legacy MCP entry"); a whole entry under the same name with
    `"enabled": false` turned it off, so turning a server off needs its name. `opencode mcp list`
    has no `--standalone` and asks the background service, so the names cannot be listed without
    starting or using that service, and Vimma would otherwise have to read every source above
    itself. A `permissions` rule denying `*.*` and allowing `vimma.*` left the other server's
    tools in the catalog. No option leaves the configured servers out, as Claude Code's
    `--strict-mcp-config` does. The ticket can stay out of the arguments: `OPENCODE_CONFIG`
    names a file whose server entry carries it in `environment`, and the server received it.
  - Sessions and the logins `opencode auth login` stores are in one SQLite database,
    `$XDG_DATA_HOME/opencode/opencode.db` (`OPENCODE_DB` names another). With
    `OPENCODE_DB=:memory:` a run kept no database file, but a stored key (added with
    `opencode auth import`) was no longer sent, while a key in the configuration was; with the
    file, the run's session stayed in it. A shell command's output stayed under
    `$XDG_DATA_HOME/opencode/shell/` either way.
  - Without `--auto`, a permission request is refused ("This non-interactive run cannot ask the
    user for permission"); under the default permissions a `shell` call (`ls`) ran without one.
    A configuration file that does not parse is skipped with a warning in opencode's log, and
    the run goes on with the rest, its default provider included.

## Design

1. **The CLI is an MCP client of the conversation's own gate connection** (C1, Behaviour 8).
   Vimma gives the CLI exactly one MCP server, `vimma-ctl mcp`, which connects to the control
   socket with a one-time ticket instead of the token (C3), and the server binds that connection
   to the conversation's gate connection (`builtin:<n>`, M35): its label, its tabs (M36), its
   grant (M37), its rates and its budget. So every rule of §12 holds for the CLI's steps, the
   conversation grant made by `Enter` covers them as it covers a model provider's (builtin-agent
   B18), and checkpoints ask in the window's prompt slot. Rejected: the ordinary agent role with
   the token and `:mcp on`, because it opens the agent role to every local process
   (builtin-agent B4) and the CLI's connection would be an MCP agent with a grant of its own,
   asked on the question line, not the conversation; Claude Code's in-process "SDK" MCP servers
   over its own stdio, because they are not in its `--help`, serve one CLI only, and would make
   Vimma parse MCP traffic mixed into the CLI's output; an MCP server over HTTP served by Vimma,
   because it adds a listener that pages could reach by URL. ADR-023 gains an amendment: a model
   client inside the browser may also be an external CLI driving the in-process connection.
2. **Vimma builds the command line; there is no shell** (C2, Behaviour 7). The process starts
   with `Subprocess.call`, its `command` the confirmed absolute path (C4) and its `arguments` an
   array that `agent-cli.mjs` builds from fixed parts and the provider's `model`, so no value is
   ever parsed by a shell and the task text is never an argument but written to stdin, where a
   leading `-` or a quote is plain text. The arguments, with the task on stdin:

   ```text
   claude-code: -p --input-format stream-json --output-format stream-json --verbose
                --no-session-persistence --strict-mcp-config --mcp-config <file>
                --allowedTools mcp__vimma --permission-mode dontAsk [--model <m>]
   codex:       exec --json --ephemeral --skip-git-repo-check -C <dir>
                -c mcp_servers.vimma_chat={command=<vimma-ctl>,args=["mcp"],
                   env_vars=["VIMMA_AGENT_TICKET","VIMMA_AGENT_PORT"],
                   default_tools_approval_mode="approve",required=true,enabled=true}
                -c shell_environment_policy.set.VIMMA_AGENT_TICKET=""
                -c shell_environment_policy.set.VIMMA_AGENT_PORT=""
                [-c mcp_servers.<other>.enabled=false]...
                --disable apps --disable plugins
                --disable skill_mcp_dependency_install [-m <m>] -
   ```

   The builders are pure functions in `packages/vimma-core`, so the exact argument list of each CLI is a
   vitest fixture. Codex's `<other>` names come from `codex mcp list --json`, run with fixed
   arguments from the confirmed path before the ticket is made; a name that is not letters,
   digits, `_` or `-` refuses the run, so no name can add a key of its own to the arguments. Rejected: a user-written command line, because it needs a shell or a parser
   of quoting rules, and an argument such as `--dangerously-skip-permissions` or
   `--output-format text` would silently break the confinement statement or the transcript;
   `--bare` for Claude Code, because it reads no OAuth login, so a subscription user could not
   use it.

3. **A one-time ticket, delivered in the environment** (C3, Behaviour 7-8, 11). For each run,
   Vimma makes a random 256-bit ticket bound to the conversation's connection, valid until the
   run ends, and starts the control socket's listener if it is not already on, accepting on it,
   while no switch of S1 is on, only an `agent-hello` that carries a live ticket. The ticket and
   the port reach `vimma-ctl mcp` as `VIMMA_AGENT_TICKET` and `VIMMA_AGENT_PORT` in its own
   environment, through the MCP configuration (Claude Code's `--mcp-config` file's `env`,
   written mode 0600 in the run's 0700 directory; for Codex, Codex's own environment, which its
   server table's `env_vars` passes on by name, and which its shell commands get with both
   variables set empty, Research), never in a process's arguments,
   which other users can read in `/proc/<pid>/cmdline`. The handshake is S4's with the ticket
   as the key, so the server proves it knows the ticket before the client sends anything. The
   hello names the ticket by its id, HMAC-SHA256(ticket, `vimma-ticket` NUL), because the server
   must know which live ticket to prove before the client may send one, and the id gives a
   squatter on a stale port nothing it could use. With a ticket, `vimma-ctl mcp` never reads the
   discovery file, because a process the CLI runs must never hold the token. One
   ticket serves one connection; a reconnect of the same `vimma-ctl` process uses its session id
   (mcp-session-grants) within the same run; a second connection with the ticket is refused and
   shown as a notice, `a second program used claude-code's ticket and was refused`. A process
   that reads the ticket (the CLI's own shell can read its environment) reaches only what the
   conversation already reaches, on the conversation's tabs and grant, since the ticket names
   nothing else. A ticket's connection counts toward S5's eight connections but not its four
   agents, because a task the user started must not be kept out by MCP agents. The listener
   runs with MCP off, for tickets only, writing no discovery file, because it accepts nothing
   but a ticket that only Vimma has handed out, for one run, and a CLI provider then works with
   MCP and full control off, as the chat window's other providers do (M35). Rejected: the
   token, because it opens every agent connection; a ticket in the command line, for `/proc`;
   requiring `:mcp on` for CLI providers, because it opens the agent role to every local
   process for as long as MCP is on, which is the access builtin-agent B4 chose not to give.
4. **The program is chosen in setup, never in `config.toml`** (C4, Behaviour 1-2). F3 says no
   config value is run as a command, because `config.toml` is a file users copy from others and
   keep in dotfile repositories, so a CLI provider in `config.toml` names only which supported
   CLI and model it is, and the path is a pref that setup writes after the user picks it in the
   list of what `PATH` holds. Before each run Vimma checks that the path is absolute, a regular
   file (symlinks resolved), executable, owned by the user or root, not writable by other
   users, and that every folder above it, up to `/`, is the user's or root's and not writable
   by other users unless it is sticky (as `/tmp` is, where only an entry's owner may replace
   it), because a file another local user can replace, or a folder above it they can swap,
   would let that user run code as this user when a task is sent. Neither IOUtils nor nsIFile
   gives a file's owner, and IOUtils drops the sticky bit, so both are read with the
   `statx`/`lstat` call security.md C2 already allows for clamd's socket.

   The pref keeps the path as `PATH` held it, links included, and that path is what runs; the
   checks resolve it at each run. Resolving it once in setup and keeping the file broke two
   kinds of install: a version manager's shim (mise, asdf, rtx, volta, proto, aqua) is a link
   named as the tool to one program that picks the tool by the name it is started as, so the
   resolved `/usr/bin/mise`, started as `mise` with Claude Code's arguments, exited 2; and a
   versioned file (`.../mise/installs/claude/2.1.303/claude`, Claude Code's own
   `~/.local/share/claude/versions/2.1.303`) is gone after an upgrade, which a stable link
   follows. Running the link keeps the guarantee above because the link is judged as the file
   is: the path is resolved one entry at a time, as the kernel does, so every link on the way,
   each hop of a chain of links included, must be owned by the user or root, and every folder
   an entry is looked up in (above the file, above each link) must be the user's or root's and
   not writable by others unless sticky. Only the user or root can then repoint a link or
   replace the file, and since all of it is checked again before every run, a link repointed
   since setup is judged by where it leads now. The checks cover the file the path names: a
   version manager's shim (mise, asdf, volta) then runs the real tool from the manager's own
   install folder and configuration, which Vimma does not check (a group-writable
   `MISE_DATA_DIR`, for example), as a script's `#!` interpreter is found on the user's `PATH`
   (security.md M55). A link's own mode is not judged, since it means nothing on Linux or
   macOS. nsIFile follows a chain of links to its end and hides the links between, so one
   link's target is read with `readlink(2)`, from the library the `statx`/`lstat` call already
   opens: the one native call this adds.

   A program a link named as the CLI leads to is a dispatcher when its own name differs from
   the CLI's, unless that name is a version (Claude Code's native installer keeps each version
   as a file named by it) or has an extension (npm's `cli.js`, a script its interpreter is
   given by path); only the name is read, since the rule decides only setup's wording and the
   refusal below. A stored path that names a dispatcher itself, not through a link named as the
   CLI, is refused at the run and in the picker,
   `claude-code at /usr/bin/mise is refused: it is mise, which runs claude only through a link named claude; add: agent CLI finds it again`,
   because that is what an earlier release stored and it cannot run; picking the CLI in setup
   again stores the shim. A path that is gone gets the same `add: agent CLI finds it again`. `vimma-ctl`, which the CLI runs with the ticket, is the one next to Vimma's
   binary (where every release puts it), else the pref `vimma.agent.cli.vimmaCtl` (a build from
   source, tests). The pref's file is checked the same way; the one beside the binary has its
   own file checked, but not the folders above it, because they hold Vimma's binary, so a user
   who can swap one of them can already change Vimma, and because on macOS `/Applications` is
   writable by the admin group, which would refuse every install there; a link there to a file
   outside the binary's folder has that file's folders judged in full, and a chain of links
   through any other folder has that folder and its links judged even when it ends beside the
   binary, because the reason covers only the folders on the way to the binary and the kernel
   follows the chain again at each run. Rejected: a `command` key in
   `config.toml`, because it breaks F3; root-owned files only, as for ClamAV (C2 of
   security.md), because user installs (`~/.local/bin`, version managers) are where these CLIs
   live.

5. **The CLI keeps no session; Vimma's stored conversation is the memory** (C5, Behaviour 12).
   Each task is a new process given the stored conversation, and Vimma asks the CLI not to save
   its session (`--no-session-persistence`, `--ephemeral`), because a CLI's session files hold
   every tool result, so they would keep, unencrypted and outside Vimma's control, the page text
   builtin-agent B15 keeps out of storage. A CLI that cannot be asked (Gemini CLI, Research) is
   supported only once its session files can be kept out of storage or the window states that
   they are kept. The environment is Vimma's own (`environmentAppend`), so the CLI finds its
   login, `HOME` and `PATH`, minus the variables Vimma and Firefox set for themselves (`MOZ_*`,
   `VIMMA_*`, and `XRE_*` and `XUL_*`, which name the profile and the application), so that
   nothing of the browser's leaks into the CLI's shell. Rejected: resuming
   the CLI's session between tasks (`exec resume`, `--resume`), because it needs the session
   files above; an `env` key in `config.toml`, because a CLI's login is the CLI's matter and
   variables such as `LD_PRELOAD` would run code (F3).
6. **An empty working directory per run** (C6, Behaviour 7). Each run's `workdir` is a new 0700
   directory, removed when the run ends, so that the CLI loads no project's instruction files,
   hooks or settings from wherever Vimma was started, and its file tools start in a place that
   holds nothing. It is in `$XDG_RUNTIME_DIR` when there is one (the user's own 0700 folder
   under root's `/run`), else in `~/.cache/vimma-agent-cli` (made 0700), and a run is refused
   when a folder above it is another user's or writable by others, sticky ones included,
   because Claude Code reads its project instruction files from every folder above its
   working directory, so one another user planted in a shared `/tmp` would steer every run
   with the conversation's grant. It is outside the profile, because a directory inside it puts
   the cookies and logins one `..` away. This does not confine a CLI
   with a shell or file tools, which reach every file the CLI's own settings let them reach;
   C7 says so in the window. A file the CLI writes in this directory is removed with it, and
   the guide says so.
7. **The CLI keeps the tools its own configuration allows, and the window states them** (C7,
   Behaviour 4-5, 9). Vimma passes no flag that removes or adds a CLI's own tools: Claude Code
   runs with the tools and permission rules of its own settings, and Codex with the sandbox
   and approvals of its own `config.toml`. Vimma adds only what its own server needs:
   `--allowedTools mcp__vimma`, and `--permission-mode dontAsk`, because a headless run has
   nobody to answer the CLI's own prompts, so a tool the settings do not already allow is
   refused instead of waiting. The reasons: a user picks a CLI for what it can do, and tasks
   that join the browser with the user's files (saving what a page lists, filling a form from a
   local document) need the CLI's file and shell tools; the CLI's permission settings are a
   trust decision the user has already made for that CLI in a terminal; and Codex cannot turn
   its shell off, so a narrowing flag would give one CLI a guarantee the other lacks. Vimma's
   own guarantee is the browser: the CLI reaches pages only through the conversation's gate
   connection (C1), and `--strict-mcp-config` keeps every other MCP server out of the run
   (for Codex, which has no such flag: each server `codex mcp list` names turned off by name,
   its apps, plugins and a skill's server installs off, and a call to a server other than Vimma's ends the run),
   because another server (a second browser driver, a `vimma-ctl` with the token) would reach
   pages outside the agent workspace and outside the gate. So that the user sees what the CLI
   can do, the header lists the CLI's own tools from Claude Code's `system`/`init` `tools`,
   without `mcp__vimma__*`, as the CLI reported them for this run; for Codex, whose events
   report no tool list and no sandbox (Research), it says `as its configuration allows`. The list is the
   CLI's report, and the transcript's own-tool lines (Behaviour 9) are taken from the CLI's
   stream, so both are what the CLI says, not what Vimma observed. Rejected: the narrowest
   setting each CLI documents (`--tools ""`, `--sandbox read-only`), because it breaks the
   tasks above, differs per CLI, and would make the window promise a confinement that Vimma
   does not enforce; a provider key that widens a narrowed default, because it gives two
   modes to test and explain while the narrowed one fits few of the tasks a CLI is picked for;
   Vimma sandboxing the process itself (namespaces, seccomp, Landlock), because that is a
   launcher of its own per platform, breaks the CLI's login and update paths, and is a larger
   surface than it removes.
8. **The transcript maps the CLI's stream; the gate's record wins** (C8, Behaviour 8-9, 13).
   `agent-cli.mjs` reads stdout as JSON lines (at most 1 MiB a line, as S5; a run over 64 MiB of
   output is stopped) and maps each CLI's events to the transcript's entries:

   | Transcript entry      | Claude Code (`stream-json`)                                  | Codex (`exec --json`)                                    |
   | --------------------- | ------------------------------------------------------------ | -------------------------------------------------------- |
   | run started, model    | `system`/`init`: `model`; `mcp_servers` must say `connected` | `thread.started` (the provider's model)                  |
   | agent reply           | `assistant` block `text`                                     | `item.completed` with an `agent_message`                 |
   | step in the browser   | from the gate (not from `tool_use` of `mcp__vimma__*`)       | from the gate (not from `mcp_tool_call` of `vimma_chat`) |
   | CLI's own tool        | `assistant` block `tool_use` of any other name               | `item.started` with `command_execution`, `file_change`   |
   | own tool refused      | `system`/`permission_denied` with its `tool_use_id`          | not reported                                             |
   | tokens, cost          | `result`: `usage`, `total_cost_usd`                          | `turn.completed`: `usage`                                |
   | task ended, or failed | `result` (`is_error`, `subtype`); exit code                  | `turn.completed` or `turn.failed`, `error`; exit code    |
   | ignored               | other `system` subtypes, `tool_result` bodies, thinking      | `reasoning`, `todo_list`, `item.updated`, unknown kinds  |

   An own-tool line whose call the CLI's settings refused says `refused by its settings`,
   because a line that says the CLI ran a command it was not allowed to run would be wrong. An
   `assistant` message with a top-level `error` is not a reply: it repeats the result's error,
   which the task's end shows once. The input closes after a `result` whose
   `queued_turn_count` is 0, so the CLI exits; a message added during the turn is part of that
   turn (Research).

   Steps in the browser are taken from the gate, because the gate is what ran them and decided
   their outcome, while the CLI's stream is the CLI's account of it; a CLI that reports a step
   the gate never saw shows nothing. An init whose `vimma` server is not `connected` ends the
   run with `claude-code could not start vimma-ctl`, because the task would otherwise run with
   no browser tools and the model might use other means. Codex reports no server status, so
   its `required` server ends the run when it does not start, and an `mcp_tool_call` of a
   server other than `vimma_chat` ends it with `codex called an MCP server that is not Vimma's:
<name>`, because the arguments turned every other server off. Every value is rendered as text (B9),
   and stderr is drained and only its last 4 KB kept, for Behaviour 13. An unknown line or event
   is ignored and counted, so that a CLI update that adds events does not break the window; a
   CLI version whose `init` or `result` no longer parses ends the run with
   `claude-code 2.2.0 speaks a stream Vimma does not read`.

9. **Stop closes the browser side first** (C9, Behaviour 11). Stopping ends the grant and
   closes the ticket's connection in the browser before it signals the process, so that a CLI
   that ignores `SIGTERM`, or a child of it that outlives it (Subprocess signals only the pid,
   Research), cannot take a step after the stop. `proc.kill(3000)` then gives the CLI 3 s, as
   native messaging gives its programs, to end its own children, its MCP server among them,
   before `SIGKILL`. Vimma does not track the CLI's children beyond that, because Subprocess
   offers no process group; the guide says that a shell command the CLI started may outlive a
   stop, and `limits.md` lists it.
10. **Budgets Vimma can count are enforced in the browser; the CLI's reports add to them**
    (C10, Behaviour 14-16). Steps are counted by the gate, so a CLI cannot under-report them.
    Tokens come only from the CLI's report, because the CLI talks to its provider and Vimma
    sees neither the requests nor the prices; where they are reported, `max_tokens` applies,
    and cost is handled by C13. The `max_minutes` limit exists for CLIs only, because a CLI can spend minutes and money on its
    own tools or its own reasoning without a single step reaching the gate, and wall-clock time
    is the one measure Vimma has of that; 30 minutes is the bench's time limit
    ([agent-speed](agent-speed.md), Summary). Rejected: a token estimate from the stream's text,
    because most of a CLI's input (its system text, tool definitions, cached context) never
    appears in its output, so the estimate would be far too low and look precise.
11. **A CLI is never local-only** (C11, Behaviour 6), because Vimma cannot see where a CLI sends
    what it reads: even a CLI pointed at a local model may fall back to a hosted one, so
    `local_only` refuses every CLI provider rather than trusting a CLI's own setting.
12. **Claude Code first, Codex second; others once their output is checked** (C12, Delivery).
    Claude Code first, because each part of this design was checked against it (Research): a
    live input for added instructions, an MCP configuration from a file with every other server
    left out, a list of its own tools in its init, a reported cost, and no session files.
    Codex second, because its JSON events and `--ephemeral` are documented, but it has no live
    input, no flag that leaves its configured MCP servers out, and its events report no list
    of its own tools; Delivery 3 recorded its runs (Research). Gemini CLI and opencode each get their
    own PR after a run against a scripted server records their events, because neither offers a
    way to keep its session files out of storage that was found, and opencode's event shape is
    unknown; until then they are not offered in setup. Adding a CLI is one entry in `CLIS`
    (`agent-cli.mjs`), which must supply its id, program name, title, suggested model, model
    list, version arguments, argument builder, MCP configuration, input line and stream parser
    (with its usage, cost and own tools), because the window, the conversations and the runner
    read every per-CLI fact from that entry, and a unit test checks each entry for all of them.

    (Since changed: opencode 2.0.32 was run against a scripted server and is still not offered,
    because it cannot meet C5 and C7 as they stand. It keeps no session only with an in-memory
    database, which also hides the logins `opencode auth login` stores. The MCP servers of its
    configuration can be turned off only by name, and only its background service lists the
    names. Its MCP tools reach the model only through Code Mode, and not in a step that starts
    before Vimma's server has connected. Research, "opencode 2.0.32"; issue #727.)

13. **A CLI's cost is shown, and `max_cost` does not apply to it** (C13, Behaviour 15). The
    status bar shows a reported cost as `≈ $0.41 (claude-code)` while the task runs, and the
    task's end line keeps it as `done · ≈ $0.41 (claude-code estimate)`, because it is the only
    measure of how much of a plan's limit a task used, and the status bar clears when the task
    ends, so the end line is where it can still be read; the `≈`, the CLI's name and `estimate`
    say whose estimate it is, and the guide says it is not a bill. `max_cost` is not enforced for a CLI provider, and
    Vimma passes no `--max-budget-usd`, because Claude Code computes the cost at list prices
    even when the user pays by subscription, so a task would be stopped over money that is not
    being spent, and Codex reports no cost, so the limit would hold for one CLI only. Steps
    (C10, counted by the gate), tokens where the CLI reports them, and `max_minutes` still
    apply. Rejected: applying `max_cost` to the reported cost, for the reasons above; showing the
    cost only when `max_cost` is set, because the measure is as useful without a limit; never
    showing it, because the user then has no measure of a task's use of the plan at all.

## Security and privacy

What is new: chrome starts a user-chosen program when the user sends a task; the control
socket's listener may run with MCP off, for ticket connections only; and a program with tools
of its own receives the page text the agent reads.

### What stays as it was

The CLI acts on the browser only through the agent tools, on the conversation's connection, so
every rule of §12 applies to its steps: the agent workspace only, the conversation's own tabs
(M36), the conversation grant and its end (M37), checkpoints, rates and `:mcp log`. Nothing the
CLI writes answers a question or makes a grant (builtin-agent B19): its output reaches only the
transcript, as text.

### What is new, and what bounds it

- **Starting a process.** Only the user's send of a task in the chat window, a key press in
  Vimma's chrome that no page or socket command can make, starts a CLI. The program is one the
  user picked in setup, checked at each run (C4); its arguments are fixed per CLI (C2); there is
  no shell; the task text goes to stdin. `config.toml` cannot name a program (F3).
- **The ticket.** It reaches only the conversation's connection, for one run, through one
  connection. A local process that reads it (any process of the user can read the CLI's
  environment) gains nothing the conversation does not already have, and only until the run
  ends. Other users cannot read it: it is not in any command line, and the MCP configuration
  file is mode 0600 in a 0700 directory. The listener that accepts it is S2's (127.0.0.1 only)
  with S4's handshake, S5's limits and S11's framing and validator.
- **The CLI's own tools are outside Vimma's gate.** The CLI keeps the shell, file and web
  tools its own configuration allows (C7). Vimma neither approves nor refuses them, counts
  them toward no budget, and does not confine what they do: they act with the user's rights,
  under the CLI's permission model only. A prompt-injected page can steer the CLI's model to
  use them, for example to read a file the user can read and send it to the model's provider
  in its context, or to run a command. What bounds this is the CLI's own settings, set in the
  CLI by its user; what Vimma adds is that the first-task notice says the tools are not confined,
  the header lists those the CLI reported for the run, and each use is a marked transcript
  line. The guide says that a CLI provider extends the user's trust to the CLI as in a
  terminal (§11, "What agents do outside Vimma").
- **Where data goes.** Page text goes to the CLI and from it to whatever model the CLI uses,
  under that CLI's terms; Vimma cannot see where, so `local_only` refuses CLIs (C11), and the
  header never says `stays on this machine` for one.
- **What is kept.** Vimma stores the conversation as for any provider (builtin-agent B15). The
  CLI is asked to keep no session (C5); its own logs and telemetry are its matter, and the
  guide links to each CLI's documentation.

### `docs/security.md` changes, with the implementation

- C2 gains a third exception, with its tests: an agent CLI from the path setup confirmed,
  checked at each run (absolute, regular, executable, owned by the user or root, not writable by
  others), with arguments from fixed builders per CLI, the task on stdin, no shell, started only
  by sending a task in the chat window.
- S1 and S12: while a CLI task runs, the listener **may** run with both switches off, and then
  **must** accept only an `agent-hello` with a live ticket; it stops when the last such run
  ends.
- §12, "The built-in agent", new rules:
  - a ticket **must** be 256 random bits, bound to one conversation's connection, valid only
    during its run, for one connection (and that connection's reconnects by session id); a
    second connection with it **must** be refused with a notice;
  - a ticket connection **must** act as the conversation's connection (M35-M37) and **never**
    as an MCP agent's;
  - the ticket **must never** appear in a command line, a pref, `config.toml`, a log, a notice
    or the transcript; the MCP configuration file **must** be 0600 in a 0700 directory and
    removed with the run;
  - a stop **must** end the grant and close the ticket's connection before the process is
    signalled;
  - a CLI's output **must** be rendered as text and **must never** answer a question, make a
    grant or fill the prompt slot;
  - a CLI's own shell and file tools (and its web tools) are **outside** Vimma's gate: Vimma
    does not approve, refuse, count or confine them, and they act with the user's rights under
    the CLI's own permission settings; the window **must** say that they are not confined and
    **must** list the tools the CLI reports as enabled for the run;
  - Vimma **must** give a CLI no MCP server but its own (`--strict-mcp-config`), so that the
    CLI reaches pages only through the gate;
  - steps **must** be counted by the gate; `max_minutes` **must** stop a CLI task; `max_cost`
    is not enforced for a CLI, whose reported cost is shown as an estimate;
  - `local_only` **must** refuse every CLI provider;
  - a `command`, `path`, `args` or `env` key in a CLI provider **must** be a config error.

## Tests

### Vitest (`packages/vimma-core`)

- `agent-cli.test.mjs`: `claude-code's arguments are the fixture, with the model only from
the provider`; `no argument removes or adds a cli's own tools`; `claude-code's init tools
become the header's list, without mcp__vimma`; `a cli with no reported tool list states its
configuration`; `codex's arguments are the fixture`; `the task is never an argument`;
  `a recorded claude-code stream maps to replies, own-tool lines, usage and cost`;
  `a recorded codex stream maps to replies, own-tool lines and usage`; `mcp__vimma tool calls
in the stream are not transcript steps`; `an init whose vimma server is not connected ends
the run`; `an unknown event is ignored and counted`; `a stream that no longer parses ends the
run naming the version`; `a line over 1 MiB ends the run`; `an own-tool line is cut at 200
characters`. The recorded streams are fixtures made by runs against a scripted server, as in
  Research.
- `agent-cli.test.mjs`: `a typed model is checked with the rule the arguments use`;
  `setup suggests each cli's model, and empty is the cli's own default`.
- `config-agent.test.mjs`: `a cli provider parses with cli and model`; `command, path, args and
env in a cli provider are errors with their line`; `a cli provider's model is refused by the
rule its run uses`; `local_only refuses a cli provider`;
  `max_minutes parses within its bounds`.
- `agent-config.test.mjs`: `an agent cli keeps its max_minutes when it is not the default`.
- `agent-cli.test.mjs`: `a link through a hop in another folder has that folder and link judged`.
- `control-v2.test.mjs`: `an agent hello with a ticket validates; a ticket and a token together
do not`.
- `agent-budget.test.mjs`: `a cli task stops at max_minutes`; `reported cost is shown and
max_cost does not stop a cli task`; `reported tokens count toward max_tokens`; `no report
shows steps and time only`.

### Rust (`tools/vimma-ctl`)

- `mcp_connects_with_a_ticket_from_the_environment`; `the_ticket_is_never_printed`;
  `a_ticket_handshake_proves_the_server_first`.

### Mochitests (`tests/browser/`)

`browser_vimma_agent_cli.js` (Delivery 1: the ticket) and `browser_vimma_agent_cli_run.js`
(Delivery 2: the run), with a fake CLI, `fake_vimma_agent_cli.py`: a script that takes Claude
Code's arguments, starts the real `vimma-ctl mcp` its MCP configuration names, and prints
Claude Code's stream-json, scripted by the task's text; it also covers
`test_added_instruction_reaches_the_running_cli` and
`test_a_later_task_is_a_new_run_given_the_conversation`:
`test_setup_lists_only_found_clis_and_stores_the_path`;
`test_a_shim_runs_as_the_cli_it_is_named_after` (a link named `claude` to
`fake_vimma_agent_dispatcher.py`, which picks the tool by the name it is started as);
`test_setup_asks_the_clis_model_and_saves_it`; `test_an_empty_model_leaves_it_to_the_cli`; `test_path_checks_refuse_a_file_others_can_write`;
`test_no_process_before_a_task`; `test_task_on_stdin_and_fixed_arguments`;
`test_runs_in_an_empty_private_directory_removed_after`;
`test_ticket_connection_acts_as_the_conversation`; `test_ticket_listener_with_mcp_off_takes_only_tickets`;
`test_mcp_agents_cannot_keep_out_a_ticket`; `test_second_connection_with_a_ticket_is_refused`;
`test_a_request_id_in_flight_is_not_reused`;
`test_ticket_never_in_prefs_files_notices_or_log`; `test_stop_and_delete_close_the_ticket_connection`;
`test_ticket_never_in_cmdline_prefs_or_log`;
`test_enter_grant_covers_cli_steps_and_checkpoints_ask`; `test_stop_closes_the_connection_before_the_signal`;
`test_cli_that_ignores_sigterm_is_killed_and_takes_no_step`; `test_own_tool_lines_are_marked`;
`test_first_task_notice_says_the_clis_own_tools_are_not_confined`;
`test_header_lists_the_clis_own_tools_from_its_init`; `test_only_vimmas_mcp_server_is_given`;
`test_max_cost_set_is_reported_as_not_applying`; `test_local_only_refuses_a_cli`;
`test_max_steps_counted_by_the_gate`; `test_max_minutes_stops_the_task`;
`test_missing_or_failing_cli_reports_its_error`; `test_the_picker_lists_the_clis_models_and_uses_one`;
`test_the_reported_cost_stays_on_the_end_line`; `test_vimma_ctl_beside_the_binary_is_judged_as_the_binary_is`;
`test_a_link_beside_the_binary_is_judged_where_it_leads`;
`test_agent_clis_are_on_with_a_pref_to_turn_them_off`.

`browser_vimma_agent_cli_codex.js` (Delivery 3: Codex), with `fake_vimma_agent_codex.py`, which
answers `codex --version` and `codex mcp list --json`, reads each `-c` value as TOML, starts the
server the `vimma_chat` table names with only the variables its `env_vars` names, and prints
`codex exec --json`: `test_setup_finds_codex_with_its_version`;
`test_task_on_stdin_which_closes_and_fixed_arguments`;
`test_every_other_server_of_codexs_configuration_is_off`;
`test_a_server_named_as_vimmas_refuses_the_run`;
`test_ticket_by_name_in_codexs_environment_never_an_argument`;
`test_header_and_start_line_name_codexs_configuration`;
`test_codexs_own_commands_and_files_are_its_own_lines`;
`test_a_call_to_a_server_not_vimmas_ends_the_run`; `test_a_rejected_key_is_the_runs_error`;
`test_a_message_during_the_task_is_held_for_the_next_run`;
`test_a_held_message_is_not_sent_after_a_stop`.

### e2e (`tools/e2e`, under Xvfb)

- `m0-agent-cli`: the fake CLI through the real `vimma-ctl mcp` on the fixture shop, a three-item
  task sent with `Enter`, ending at the payment checkpoint in the prompt slot answered `n`.
  Screenshots with the Omarchy theme: setup's CLI list, the header with the fake CLI's own
  tools listed, an own-tool line, a stopped task. It lands with Delivery 3, because a scenario
  can name neither a program by its path in the checkout nor a `PATH` for setup's search, and
  the harness's profile, with its `HOME` under the shared `/tmp` and no `$XDG_RUNTIME_DIR`, has
  no run folder C6 accepts; the harness gains both with it (a scenario's `programs`, a private
  `XDG_RUNTIME_DIR`, `checkout:` pref values, and a `type` step). The task's three items are
  the CLI's own `Bash` call, `vimma_open` of the shop, and `vimma_activate` of its pay button
  after `vimma_elements`. Claude Code is turned on before it (Delivery 2) because the
  mochitests already run the whole flow with the fake CLI and the real `vimma-ctl mcp`, from
  setup in the window to a stopped task, and Delivery 2's screens were checked in a real build
  with the Omarchy theme; the scenario adds a regression screenshot, not coverage.

## Docs and changelog

- `docs/guide.md`, "Built-in agent": "Using an agent CLI": setup, what is sent where, that the
  CLI keeps the tools its own settings allow, outside Vimma's gate, and where the window lists
  them, how added instructions and stopping work per CLI, budgets, and that the cost shown is
  the CLI's estimate and no limit; "Connecting an agent's
  tool" links to it as the way to use a CLI without `:mcp on`.
- `docs/security.md`: the changes above, with their tests.
- `docs/limits.md`, "Agents (MCP)": a CLI's own tools are outside the gate; a CLI's cost is
  its own estimate and `max_cost` does not apply to it; a shell command a CLI started may
  outlive a stop; Vimma cannot see where a CLI sends page text; supported CLIs and
  the versions checked; the run folder is in `$XDG_RUNTIME_DIR`, a small in-memory file
  system, so a CLI that writes large files there can fill it; and, where it falls back to
  `~/.cache/vimma-agent-cli`, the user's own instruction files in the home folder apply to
  every run, as they do to the CLI in a terminal.
- ADR-023: the amendment of C1.
- README: the agents line names agent CLIs as providers, with the pull request that turns Claude Code on.
- `CHANGELOG.md`: a line under [Unreleased] with the pull request that turns Claude Code on.

The guide's section, "Using an agent CLI in the chat window", the README's agents line and
`limits.md`'s lines land with Delivery 2, which turns Claude Code on, because CONTRIBUTING.md
("Unfinished features") has the pull request that finishes a feature add its docs. The guide's
section also lists the window's messages for a CLI provider and what to do about each, and
where `vimma-ctl` must be.

## Delivery

Delivery 1 and 2 were built behind `vimma.feature.agentCli` (default `false`), after
builtin-agent's chat window (its Delivery 4), which this feature needs. Delivery 2 turns Claude
Code on, ahead of Codex: the chat window is on by default since builtin-agent's key landed, and
Claude Code is complete and reviewed on its own, so a user with Claude Code need not wait for
Codex's checks (C12), which do not change Claude Code's code. The feature pref goes, as
CONTRIBUTING.md has the finishing pull request remove it, and `vimma.agent.cli.enabled`
(default `true`) takes its place as a switch that turns every agent CLI off without a release,
since a CLI runs a program of the user's.

1. `feat(ctl): one-time tickets bind a vimma-ctl connection to a conversation` (C1, C3): the
   ticket hello in `control.mjs`, the ticket-only listener, binding to `builtin:<n>`,
   `vimma-ctl mcp` reading `VIMMA_AGENT_TICKET` and `VIMMA_AGENT_PORT`, security.md S1, S12 and
   §12 rules, vitest, Rust tests and mochitests. No user-visible change.
2. `feat(agent): claude code as a provider of the chat window` (C2, C4-C13 for Claude Code):
   `agent-cli.mjs` with Claude Code's builder and parser and recorded fixtures,
   `agent/AgentCli.sys.mjs`, setup, the notice and the header with the CLI's own tools from its
   init, budgets, `max_minutes` and the cost shown without `max_cost`, C2's exception and the
   rules on the CLI's own tools in security.md, ADR-023, the guide's section and mochitests;
   then the model picker's rows (Behaviour 17), the cost on the end line, the docs of Docs and
   changelog, and Claude Code turned on.
3. `feat(agent): codex as a provider of the chat window` (C12): Codex's builder and parser with
   fixtures recorded against a scripted server, the queued instruction of Behaviour 10, the
   check of how its MCP server receives the ticket, and the check of whether its events report
   its effective sandbox for the header; the guide and limits.md add Codex, the `agent-cli`
   e2e scenario lands with what the harness needs for it (Tests), and the status becomes
   `implemented`.
   Built in the pull request that closes #609.
4. Gemini CLI and opencode: one issue each, opened with PR 3, for the checks of C12.

## Open questions

None. The answers are decisions in Design: C3, C7 and C13.
