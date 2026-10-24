# Spec: builtin-agent

Status: draft · Area: `packages/vimma-core/src/` (new `agent-loop.mjs`, `agent-providers.mjs`,
`agent-chat.mjs`, `agent-budget.mjs`; `agent.mjs` and `agent-prompt.mjs` for the built-in
label; `config.mjs` for `[agent]`; `actions.mjs` and `defaults.mjs` for the key);
`src/browser/base/content/vimma/` (new `agent/AgentChat.sys.mjs`, `agent/AgentKeys.sys.mjs`,
`ui/agent-chat.mjs`; `ctl/agent-commands.mjs`, `ctl/AgentGate.sys.mjs`, `ui/statusbar.mjs`,
`host/agent-ui.mjs`); new `tools/agent-bench/`; `tests/e2e/fixtures/`; `docs/guide.md`,
`docs/security.md`, `docs/limits.md`, README · Upstream patches: none · ADR: a new ADR for an
in-browser model client beside [ADR-019](../adr/019-agents-over-mcp.md), written with delivery
PR 3 (B4). No new dependency (B6).

Issue: [#535](https://github.com/vimma-browser/vimma/issues/535)

Builds on [vimma-mcp](vimma-mcp.md) (the agent workspace, the gate, the question line),
[mcp-drive](mcp-drive.md), [mcp-forms](mcp-forms.md), [mcp-grants](mcp-grants.md) (one grant
per task) and [mcp-checkpoints](mcp-checkpoints.md) (sending a form and paying). Decisions of
those specs are written "vimma-mcp 21", "mcp-grants G2" and so on; this spec's own are "B1",
"B2", and so on. Engine paths are relative to `engine/` (Firefox 158.0.1,
`config/milestone.txt`). Vimma paths are under `src/browser/base/content/vimma/` unless they
start with `packages/`, `tools/` or `tests/`; they were read at commit `9ce3e9a3`.

## Summary

Vimma gets an agent of its own: a chat window where the user writes a task in as many lines as
it needs ("buy these eight things, lactose-free where there is a choice, the cheapest brand
otherwise"), watches a readable transcript of every step, adds instructions or stops it, all
from the keyboard. The agent acts only through the agent tools and the gate that MCP agents
already use, so it is confined to the agent workspace and stops at the same checkpoints,
whatever model drives it. The model is the user's choice: a local one through an
OpenAI-compatible server, so that nothing leaves the machine, or a hosted one by API key. A model
test bench comes first, so that what the guide says a model can do is what the bench measured.

## Problem

- **An agent needs a separate program today.** Agents reach Vimma through `vimma-ctl mcp` from
  an agent host such as Claude Code, Codex or opencode (guide, "Connecting an agent's tool").
  A user who wants a basket filled from a shopping list has to install and configure such a
  host, start it in a terminal and write the task there, away from the browser that does the
  work.
- **Those hosts are coding tools.** They bring a shell and file access that a shopping task does
  not need, so the user's trust in the task extends to everything the host may do outside
  Vimma, which Vimma cannot bound (security.md §11, "What agents do outside Vimma").
- **There is no local option inside the browser.** A user who does not want page text sent to a
  hosted model has to find an agent host that speaks to a local server and wire it to
  `vimma-ctl mcp` themselves.
- **No one knows which models can do the tasks.** In one run of Claude Code through `vimma-ctl
mcp` on a real grocery shop (the shop of [mcp-checkpoints](mcp-checkpoints.md), Research),
  adding three items to the basket took about 20 tool calls, and each `vimma_elements` list was
  3 to 12 KB. The problems in that run came from the tool output (long lists, labels to search
  through), not from the model's reasoning. That run says nothing about smaller or local
  models, and no measurement exists for them.

## Behaviour

### Setup and providers

1. **Off until set up.** With no provider configured, Vimma makes no network request for the
   agent. `:agent` (and the key of B13, once delivered) opens the chat window; with no provider
   it shows setup, which offers two choices.
2. **Local model.** Setup asks only `127.0.0.1` on the usual ports of local servers: Ollama
   (11434), LM Studio (1234) and the llama.cpp server (8080), each with `GET /v1/models` and a
   timeout of 1 s. It lists the models those servers report as `ollama · qwen3:14b`, and the
   user picks one. When none answers, setup shows how to start one (`ollama serve`, then
   `ollama pull <model>`) and accepts an address such as `http://127.0.0.1:8000/v1` (vLLM's
   default port) instead. No key is asked. The probe runs only while setup is open with this option
   picked, never in the background.
3. **External provider.** The user picks Anthropic (the Messages API) or an OpenAI-compatible
   endpoint (an `https://` address), a model name, and pastes the API key into a masked field.
   The key goes straight into Firefox's login storage (B8) and is never shown again; setup shows
   `key stored · ends …a1b2` (its last four characters) and offers to replace or delete it.
4. **Choosing starts nothing.** Picking a provider or a model makes no request but the local
   probe of item 2 and, for an external provider, none at all until the first task. The agent
   runs only when the user sends a task.
5. **The first task to an external provider says what leaves.** Before the first task of a
   conversation that uses an external provider (and again after a provider change), the window
   shows, and needs a `y` to:
   `Page text the agent reads, field values it sees, screenshots and your messages are sent to api.anthropic.com (Anthropic). y send · n cancel`.
6. **The header shows where data goes.** The window's first line always names the provider, the
   model and where data goes: `local · qwen3:14b · stays on this machine` or
   `anthropic · claude-sonnet-4-5 · page text sent to api.anthropic.com`. A local address that is
   not one of the probed servers says `local endpoint 127.0.0.1:8000`, because Vimma cannot see
   whether that server forwards to a hosted model (Security and privacy).
7. **A picker switches models.** In the window, `m` (normal mode) opens a picker of the
   configured providers and the models the local servers report. Each conversation remembers
   its provider and model, so one conversation can run small tasks locally and another a harder
   task on a hosted model.
8. **`config.toml` may list providers**, by endpoint and model only:

   ```toml
   [agent]
   default = "local"           # a provider name below
   local_only = false          # true: refuse any provider that is not on 127.0.0.1 or ::1
   max_steps = 60              # B10
   max_tokens = 1000000
   max_cost = 2.00             # used only for a provider with prices

   [[agent.providers]]
   name = "local"
   kind = "openai"             # "openai" (OpenAI-compatible) or "anthropic"
   endpoint = "http://127.0.0.1:11434/v1"
   model = "qwen3:14b"
   vision = false              # B7

   [[agent.providers]]
   name = "anthropic"
   kind = "anthropic"
   endpoint = "https://api.anthropic.com"
   model = "claude-sonnet-4-5"
   price_in = 3.00             # per million input tokens, in the user's own currency
   price_out = 15.00
   ```

   A `key`, `api_key`, `token` or `password` field in `[agent]` is a config error, reported as
   every config error is, with the line, and the provider is not used.

9. **Local-only mode.** `[agent] local_only = true` refuses every endpoint whose host is not a
   loopback address (`127.0.0.1`, `::1`, `localhost`), in setup, in the picker and at each
   request, and the header says `local only`.

### The chat window

10. **Layout.** Top to bottom: the header (item 6); the transcript; the input. It uses the
    theme's tokens like every Vimma surface (Omarchy themes included) and the command line's
    font.
11. **The transcript shows the conversation and every step.** The user's messages, the
    agent's replies, and one line per tool step in the words of the step's notice
    (`clicked button "Lisää ostoskoriin" in "Maito · Kauppa"`), each with its outcome:
    `ran under grant`, `asked → yes` or `denied`. A checkpoint shows as
    `▲ asked to pay on shop.example · the page says "Total 42,90 €" → you said no`.
    Notices from the gate (a grant made, a grant ended) appear in it too. Page text never appears in the transcript
    except as the agent quotes it in a reply.
12. **Everything is plain text.** The agent's replies are shown as text with line breaks; no
    Markdown, HTML, images or clickable links (B9).
13. **Keys.** The input starts focused in insert mode: `Enter` sends, `shift+Enter` adds a line,
    `Esc` goes to normal mode. In normal mode `j`/`k`, `ctrl+d`/`ctrl+u`, `gg`/`G` move through
    the transcript, `i` or `a` returns to the input, `s` stops the running task, `m` opens the
    model picker, `n` starts a new conversation, `c` lists the conversations, `y` copies the
    selected transcript entry, `q` closes the window. `:agent stop`, `:agent new` and
    `:agent model` do the same from the command line.
14. **Instructions during a task.** A message sent while a task runs is added after the current
    step and reaches the model at its next turn; the transcript marks it
    `(added during the task)`.
15. **Stopping.** `s` in the window, `:agent stop`, or `ctrl+b shift+a` with no question waiting
    (which ends every grant, mcp-grants G4) stops the running task: the request to the model is
    aborted, a question of the built-in agent still waiting is withdrawn, and no further step
    starts. A step already running finishes, since a click that has happened cannot be undone,
    and the transcript says `stopped after "clicked …"`.
16. **The agent may ask the user.** A reply without a tool call ends the model's turn; the task
    waits for the next message. The agent asks for passwords and payment details to be typed by
    the user, as MCP agents are told to (`tools/vimma-ctl/src/mcp.rs`, `INSTRUCTIONS`).

### Confinement, gate and identity

17. **Same tools, same gate.** The built-in agent has the agent tools of `vimma-ctl mcp`
    (`vimma_tabs`, `vimma_read_page`, `vimma_open`, `vimma_close_tab`, `vimma_keys`,
    `vimma_show`, `vimma_elements`, `vimma_activate`, `vimma_fill`, `vimma_screenshot`,
    `vimma_console`) and nothing else. Each call goes through `AgentGate` like an MCP agent's:
    questions on the question line, one grant per task (mcp-grants), the checkpoints for sending
    a form and paying (mcp-checkpoints), the download rules (vimma-mcp 31), the rates, the mute,
    notices and `:mcp log`.
18. **Questions are never answered in the chat.** The gate's questions show on the question
    line as for any agent; nothing typed in the chat window answers one, and the agent's text
    never grants anything.
19. **Its name.** Questions, notices and `:mcp log` name it `built-in (qwen3:14b)`: the word
    `built-in`, then the model. An MCP client whose `agent-hello` gives a name starting with
    `built-in` is shown with ` (mcp)` after it, so no other program can pass as the built-in
    agent.
20. **One conversation is one connection.** Each conversation has its own gate connection, so a
    grant covers the task of the conversation it was given in; a new conversation asks again.
21. **One task at a time.** While a task runs, sending a task in another conversation says
    `another conversation's task is running (s stops it)`, since two tasks would work the same
    agent tabs. MCP agents may run beside it, as they may beside each other today.
22. **Independent of `:mcp on`.** The built-in agent works with MCP off, and `:mcp off` does not
    stop it, because `:mcp on` opens the control socket's agent role to local processes, which
    the built-in agent does not use (B4). `:mcp revoke`, `:mcp log` and `:mcp forget` cover it.

### Budgets and status

23. **Per-task limits.** A task stops when it reaches `[agent] max_steps` tool calls,
    `max_tokens` tokens (input and output, summed over its requests, as the provider reports
    them), or, for a provider with prices, `max_cost`. The transcript names the limit
    (`stopped: 60 steps, the limit of [agent] max_steps`) and `continue` gives the task the
    same budget again.
24. **The status bar shows progress.** While a task runs, the agent segment reads
    `◇ built-in 14/60 · 212k tok` (steps, tokens), with `· 0.41` for cost when prices are set,
    beside the grant's minutes when there is one (`◇ agent 9m`). With the window closed, the
    segment is the only sign of a running task.

## Research

### Vimma at `9ce3e9a3`

- `ctl/agent-commands.mjs`: `runAgentCommand(conn, state, command, args, rid)` (`:1348`) runs
  one agent command for a connection after its `agent-hello` (`:415`), which registers the
  connection's label with `AgentGate.connect`. Every command but hello, ping and cancel asks
  through the gate and checks after the yes that the tab and URL are still those asked about.
  The rates (`opens`, `keyCalls`, `elementCalls`, `actCalls`, …, `:66-90`) are per `ConnId`,
  and `forgetAgentConnection` (`:1328`) clears them.
- `packages/vimma-core/src/agent.mjs`: `ConnId` is `string | number` (`:277`), so an
  in-process connection needs no socket. `wrapUntrusted` (`:508`) and `untrustedHeader`
  (`:517`) put page text between delimiters a page cannot close; the comment at `:432-434`
  calls this a mitigation, not a guarantee.
- `ctl/AgentGate.sys.mjs`: an `AgentLabel` is `{ client, version?, via?, since }` (`:41`); the
  gate keeps grants, the queue and `:mcp log` in memory only.
- `tools/vimma-ctl/src/mcp.rs`: the tool definitions are fixed by
  `tools/vimma-ctl/tests/fixtures/mcp/tools-list.json` (17,538 bytes for 11 tools; the test
  `tools_list_equals_the_fixture`, `:2466`), and `INSTRUCTIONS` (`:55`) is the text every MCP
  agent gets about untrusted content, passwords and checkpoints.
- `ui/side-panel.mjs`: the side panel is Vimma's own box, the first child of `#browser`, with
  keys from `VimmaHost` in `panel` mode; the bookmarks panel (`ui/bookmarks-panel.mjs`) uses the
  same slot. `ui/agent-prompt.mjs` renders every value as text (security.md §6).
- `about/AboutVimma.sys.mjs:117`: `about:vimma` is a privileged page
  (`ALLOW_SCRIPT | IS_SECURE_CHROME_UI`).
- Fixtures: `tests/browser/file_vimma_agent_shop.html`, `file_vimma_agent_basket.html`,
  `file_vimma_agent_checkout.html`, `file_vimma_agent_hosted_pay.html`, and
  `tests/e2e/fixtures/shop.html`, `checkout.html`, `hosted-checkout.html`: a grocery basket whose
  buttons are `type=submit` outside any form, a checkout with card fields, a hosted payment page.
  Each holds a handful of products, too few to test product choice.

### Firefox 158.0.1

- **Firefox's own AI window keeps its API key in a pref.** The Smart Window's OpenAI-style
  client reads a custom endpoint from `browser.smartwindow.customEndpoint` and its key from
  `browser.smartwindow.apiKey` (`browser/components/aiwindow/models/openAIEngine.sys.mjs:19`,
  `:125-131`), so the key is in `prefs.js` in clear text. Its model tools read open tabs,
  history and page text across the profile (`browser/components/aiwindow/models/Tools.sys.mjs`,
  as listed in mcp-grants, Research). The transport is the ML engine's `OpenAIPipeline`
  (`toolkit/components/ml/content/backends/OpenAIPipeline.mjs:54`), OpenAI's API only.
- **Login storage.** Logins are encrypted with the profile's key in `key4.db` through the
  secret decoder ring (`toolkit/components/passwordmgr/crypto-SDR.sys.mjs:20-24`). That key is
  protected only by the primary password, when one is set; without one, anyone who can read the
  profile can decrypt every login. Login storage does not use the OS keyring on Linux. A login
  may have a `chrome://` origin, as Firefox Accounts' does (`FXA_PWDMGR_HOST`,
  `services/fxaccounts/FxAccountsCommon.sys.mjs:331`, stored at
  `services/fxaccounts/FxAccountsStorage.sys.mjs:502`). Only that one origin is hidden from
  `about:logins` (`toolkit/components/passwordmgr/LoginHelper.sys.mjs:1824-1826`) and skipped
  by Sync (`services/sync/modules/util.sys.mjs:668-675`,
  `services/sync/modules/engines/passwords.sys.mjs:147`), so a login of another `chrome://`
  origin is listed in `about:logins`, exported with the others, and synced when the user syncs
  passwords (Sync stays on in Vimma, [m0-mozilla-services](m0-mozilla-services.md)).
- **The OS keyring.** `OSKeyStore` uses libsecret on GTK (`security/manager/ssl/OSKeyStore.cpp:65-67`),
  so on Linux its secret lives in the desktop's keyring (GNOME Keyring, KWallet), outside the
  profile. Form autofill uses it to encrypt saved card numbers.

### Providers and local servers

From each project's API documentation, read for this spec and not exercised against a running
server:

- **Anthropic's Messages API**: `POST https://api.anthropic.com/v1/messages` with the headers
  `x-api-key` and `anthropic-version`; tools are declared with a name, description and
  `input_schema` (a JSON Schema, as MCP's `inputSchema`); a reply holds `tool_use` blocks, and
  `usage` reports `input_tokens` and `output_tokens`. The reply carries no price.
- **OpenAI-compatible chat completions**: `POST <base>/chat/completions` with
  `Authorization: Bearer <key>`; tools as `type: "function"` objects whose `function` holds a
  name, description and `parameters` (a JSON Schema); a reply's `tool_calls`; `usage` with `prompt_tokens` and
  `completion_tokens` when the server reports it. `GET <base>/models` lists models.
- **Local servers** that serve this API: Ollama (port 11434, under `/v1`), LM Studio (1234),
  the llama.cpp server (8080) and vLLM (8000). Tool calling depends on the server and on the
  model's chat template: the llama.cpp server needs `--jinja`, vLLM needs
  `--enable-auto-tool-choice` and a parser, and Ollama supports it for models whose template
  declares tools. Some servers report no `usage` when streaming.

### Agent browsers

As checked for [mcp-grants](mcp-grants.md) (Research, "Other browsers' agents"), from vendor
pages and press coverage, not by running them: Chrome's auto browse, ChatGPT Atlas's agent
mode and Perplexity Comet run the vendor's own model, in the user's own profile with its
logins (Atlas also offers a logged-out mode), and decide which steps are sensitive with that
model. Firefox 158's Smart Window has no tool that acts on pages, and keeps a custom endpoint's
key in a pref (above). None of them offers a local model for acting on pages, confines the
agent to a part of the profile, or publishes which steps always ask.

## Design

1. **A chat window, not a command line** (B1, Behaviour 10-16), because the tasks this is for
   are long and conditional (a list of items, each with preferences), they run for minutes, and
   the user needs to read what happened and correct it while it runs. A one-line command cannot
   hold the task, and notices replace each other, so they cannot hold the history. Where the
   window lives is open question 1.
2. **The agent tools and the gate are the only reach** (B2, Behaviour 17), so that the built-in
   agent is bound by the same rules as any MCP agent and every rule of security.md §12 covers it
   unchanged. It never reaches other workspaces, the private workspace or the user's logins,
   because the agent commands check every tab against the agent workspace and its container
   when each command runs (vimma-mcp 7). Rejected: tools of its own (for example a "search the
   shop" tool), because each would need its own threat review and would not reach MCP agents;
   improvements to the shared tools help both (open question 5).
3. **Safety does not depend on the model** (B3). The gate, the grant, the checkpoints, the
   confinement and the budgets are enforced in code the model's output cannot change, so that
   a small, confused or prompt-injected model is stopped at the same places as a capable one.
   The bench measures how well a model does the task; it does not measure, and the guide does
   not claim, how well a model resists injection, beyond what the bench's injection pages show.
4. **In-process, through the agent command layer** (B4, Behaviour 22). The loop runs in the
   parent process and calls `runAgentCommand` with a `ConnId` of its own (`builtin:<n>`, one per
   conversation, B5) after an internal `agent-hello`, so the gate, the rates, the log and the
   after-yes checks are the code that MCP agents go through. Rejected: connecting to the control
   socket like `vimma-ctl mcp`, because it would need `:mcp on`, which serves the agent role to
   every local process, and the token in a file; a separate MCP host process, because it adds a
   program to ship and a socket for no gain in confinement. An ADR records the new kind of
   client (a model client inside the browser) beside ADR-019.
5. **One conversation is one gate connection** (B5, Behaviour 20), because a grant is the
   user's judgement of one task (mcp-grants G1), and a conversation is the unit of a task; a
   grant that carried over to a new conversation would cover a task the user has not seen.
6. **The loop is pure and shared with the bench** (B6). The model loop (messages, tool calls,
   budgets, transcript entries) and the provider adapters live in `packages/vimma-core`, take a
   `fetch` and a tool runner as arguments, and import nothing from Firefox, so that the bench
   runs the same loop in Node against `vimma-ctl mcp`, and what the bench measures is what the
   browser runs. The adapters are written against the two HTTP APIs directly, so no SDK is
   added. The tool definitions and the system text are generated from
   `tools/vimma-ctl/tests/fixtures/mcp/tools-list.json` and `INSTRUCTIONS`, with a vitest that
   fails when they drift, so that a tool changes in one place. Rejected: Firefox's
   `OpenAIPipeline`, because it speaks only OpenAI's API, runs in the ML engine's process for
   the Smart Window, and cannot run in the bench.
7. **Screenshots only for models that see images** (B7, Behaviour 8), because a text-only model
   cannot use `vimma_screenshot` and its definition costs tokens on every request.
   `vision` defaults to true for `anthropic` and false for `openai`.
8. **API keys live in login storage, never in prefs or `config.toml`** (B8, Behaviour 3, 8). A
   key is a login with the origin `chrome://vimma-agent` and the provider's name as user name,
   so that it is encrypted as passwords are, protected by the primary password when the user set
   one, visible and deletable in `about:logins`, and never written where Firefox's Smart Window
   keeps its key (a pref in clear text, Research). `config.toml` is a file users share and keep
   in dotfile repositories, so a key there would leak with it; a key field is a config error.
   Whether the key is also encrypted with the OS keyring before it is stored is open question 4.
9. **The window renders text only** (B9, Behaviour 11-12), because the agent's replies can
   carry page text an injection wrote. Markdown images are a known way to send data out (an
   image URL that carries what the model read loads the moment it is shown), and a clickable
   link in the agent's reply can look like the user's own navigation. Every value is set with
   `textContent`, as every Vimma surface does (security.md §6). Rejected: Markdown rendering,
   for those two reasons; a privileged `about:` page for the window, because untrusted text in
   a page with chrome privileges is a larger risk than in Vimma's chrome boxes, which hold no
   markup from outside.
10. **Budgets stop a task, the model cannot raise them** (B10, Behaviour 23-24), so that a loop
    that does not converge, a page that floods the agent with text, or a model that keeps
    calling tools costs at most what the user allowed. Steps count tool calls because they are
    what the user sees; tokens count what the provider reports and, for a server that reports
    none, characters divided by four, shown with `~`. Cost is computed only from prices the user
    enters (open question 7), because providers do not return a price and a price table in Vimma
    would go out of date. The defaults (60 steps, 1,000,000 tokens) cover about three times the
    20 calls one three-item basket took (Problem), and the bench's results replace them before
    delivery PR 3.
11. **Network calls go only to the configured endpoint** (B11, Behaviour 1-4, 9). Each request
    is a `fetch` from the parent process to the provider's endpoint as configured, with
    `credentials: "omit"` (no cookies of any container) and `redirect: "error"`, so that an
    endpoint cannot forward the request, and its page text, to another address. External
    endpoints must be `https://`; `http://` is accepted only for loopback addresses. The model's
    output cannot name an endpoint. The local probe of Behaviour 2 is the only other request,
    and only to `127.0.0.1`.
12. **Setup offers local first, and probes only when asked** (B12, Behaviour 2-5). A local model
    is the choice where nothing leaves the machine, so setup lists it first; probing ports in
    the background would make Vimma contact local services the user did not ask about. A hosted
    provider says what it receives before the first task (Behaviour 5) because the page text the
    agent reads, including what the agent workspace's logins show (an address, an order
    history), goes to that provider. Whether a local model found by the probe becomes the
    default is open question 3.
13. **One key opens the window, delivered in its own keymap PR** (B13), because keymap changes
    regenerate the bindings docs and the help snapshot and go one PR at a time. Until then,
    `:agent` opens it. The key is open question 2.
14. **The bench comes first** (B14, Delivery 1-2), because the feature is only useful with a
    model that completes real tasks, and which models do so is unknown (Problem). The bench
    runs on local fixtures, so its results do not depend on a live shop and it never buys
    anything. The guide's statements about models are limited to the bench's published results,
    with the model, its size and quantisation, the server and the hardware.
15. **Conversations stay in memory** (B15), like grants and `:mcp log` (vimma-mcp 22), because a
    transcript holds page text and the user's own instructions (addresses, preferences), which
    should not outlive the session without a decision to keep them (open question 6).

## Security and privacy

What is new: a model client inside the browser that sends page text to an endpoint picked in
setup, an API key stored in the profile, and a window that shows the model's output. The reach
on pages is unchanged: the same agent tools, gate, checkpoints and rates as an MCP agent
(B2, B3).

### Prompt injection

Page text, titles, URLs, element labels and console messages are untrusted. They reach the
model inside the untrusted-content delimiters of `wrapUntrusted`, as for MCP agents, which is a
mitigation, not a guarantee. A page can therefore steer the model. What a model steered by a
page, or one that is simply wrong, can still do under a grant, stated as mcp-grants does:

- load any http or https URL in the agent workspace, and so send what it read in a URL
  (`vimma_open`, a followed link), at most 10 loads a minute, each a notice and a `:mcp log` row;
- click buttons that do not submit a form and whose words or page do not mark them as paying,
  and fill fields that are not passwords, card fields or one-time codes; a button whose script
  posts data without a form is such a click (mcp-forms F17);
- read everything the agent workspace shows, including what a login the user made there
  displays (a shop account's address and order history);
- spend the task's budget.

What it cannot do, whatever the model: send a form or take a payment step its signals
recognise without a `y` (mcp-checkpoints); reach another workspace, the private workspace or a
private window; read a password, card or one-time-code value; keep a dangerous or unscanned
download; answer a question of the gate (Behaviour 18); raise its budget (B10); choose where
its requests go (B11); render markup, images or links in the window (B9). Unlike an MCP agent
in a coding host, it has no shell, files or network of its own, so the agent workspace and the
provider are its only ways to send anything.

### What an external provider receives

Everything the model sees: the user's messages, the system text, the tool definitions, and every
tool result: page text, element lists with field values (not sensitive ones), console messages,
URLs and titles of agent tabs, and screenshots for a model with `vision`. Behaviour 5 says so
before the first task; the header says so while the window is open. The provider's own
retention and training terms apply, and the guide links to them without restating them.

### A local endpoint

Vimma sees only an address. A server on `127.0.0.1` may itself forward to a hosted model (some
local servers offer hosted models under a local name, and proxies such as LiteLLM exist for
that), and any local process can listen on a probed port. The header therefore says
`stays on this machine` only for a probed server's model the user picked, and the guide says
that a local server's own settings decide what it sends on. Malware running as the user is out
of scope (security.md §11).

### API keys

- **On disk.** A key is a login (B8): encrypted with the profile's key, which a primary password
  protects. Without a primary password, any process that can read the profile can decrypt it,
  as it can every saved password; the guide says so and recommends a primary password. A
  `chrome://vimma-agent` login appears in `about:logins`, in a password export, and in Sync when
  the user syncs passwords (Research); open question 4 is about keeping it out of those copies.
- **Other local processes** running as the user can read the profile and talk to a local
  server; Vimma does not defend against them (security.md §11). The key is not in the control
  socket's discovery file, the token, prefs, `config.toml`, the session store or any file
  Vimma writes.
- **Logs.** No key in `:mcp log`, the transcript, notices, the browser console, error messages or
  `about:vimma`. A provider's error text is shown cut at 200 characters, with any occurrence of
  the key replaced by `•••`, since some services echo a malformed header.
- **The page side.** The key's origin matches no website, so login autofill never offers it to a
  page, and `vimma_fill` never fills password fields.

### `docs/security.md` changes, with the implementation

A new subsection of §12 for the built-in agent, with rules and their tests:

- the built-in agent **must** act only through `runAgentCommand` with its own connection, so
  every §12 rule applies to it;
- nothing typed in the chat window, and nothing the model outputs, **must** ever answer a gate
  question or make a grant;
- an `agent-hello` naming a client that starts with `built-in` **must** be shown with ` (mcp)`;
- requests **must** go only to the configured endpoint, `https://` unless loopback, with no
  credentials and no redirects; `local_only` **must** refuse any non-loopback endpoint;
- an API key **must** be stored only in login storage, and **must not** appear in prefs,
  `config.toml`, logs, notices, the transcript or error text;
- the chat window **must** render every value as text;
- a task **must** stop at its budget, and `ctrl+b shift+a` **must** stop it.

### Offline and local-only use

With a local provider and `local_only = true`, no request leaves the machine but those the agent
makes in the agent workspace on the user's behalf, which go to the sites of the task.

## Tests

### Vitest (`packages/vimma-core`)

- `agent-providers.test.mjs`: `an Anthropic request carries the tools, the system text and the
key header only`; `an OpenAI-compatible request maps tools to functions`; `tool calls and usage
are read from both reply shapes`; `a reply without usage counts characters, marked as an
estimate`; `a provider error is cut and never contains the key`.
- `agent-loop.test.mjs` (with a scripted provider and tool runner): `a tool call runs through the
runner and its result goes back to the model`; `a reply without a tool call ends the turn`;
  `a message added during a task reaches the next turn`; `stop aborts the request and starts no
further step`; `a denied call is returned to the model as denied`.
- `agent-budget.test.mjs`: `a task stops at max_steps, max_tokens and max_cost`; `cost is
computed only with prices`; `continue grants the same budget again`.
- `agent-chat.test.mjs`: `transcript entries for a step, a checkpoint and a gate notice`.
- `agent-tools.test.mjs`: `the built-in tool list equals the MCP fixture`; `screenshot is left
out for a provider without vision`.
- `config.test.mjs`: `[agent] providers parse`; `a key field in [agent] is an error`;
  `local_only refuses a remote endpoint`.
- `agent-gate.test.mjs`: `a built-in connection's grant does not cover another conversation`;
  `a client named built-in over MCP is shown with (mcp)`.

### Mochitests (`tests/browser/`)

- `browser_vimma_agent_chat.js` (new), against a scripted OpenAI-compatible server on
  `127.0.0.1` (an `.sjs` file): `test_no_request_before_setup`;
  `test_probe_only_on_setup_and_only_loopback`; `test_tool_steps_ask_on_the_question_line`;
  `test_chat_text_never_answers_a_question`; `test_checkpoint_in_transcript`;
  `test_stop_withdraws_the_waiting_question`; `test_ctrl_b_shift_a_stops_the_task`;
  `test_budget_stops_the_task`; `test_reply_rendered_as_text` (a reply with HTML, a Markdown
  image and a link loads nothing); `test_external_provider_notice_before_first_task`;
  `test_requests_only_to_the_endpoint_without_credentials_or_redirects`;
  `test_works_with_mcp_off`.
- `browser_vimma_agent_keys.js` (new): `test_key_stored_as_a_login_only` (no pref, no config,
  no file but the logins); `test_key_never_in_log_notice_or_transcript`;
  `test_key_deleted_from_setup`.

### e2e (`tools/e2e`, under Xvfb)

- `agent-chat`: setup with no local server, then a scripted local server; a three-item task on
  the fixture shop through the scripted provider, ending at the payment checkpoint answered
  `n`. Screenshots with the Omarchy theme: setup, the header, a running task with the status
  bar, a checkpoint in the transcript, a stopped task.

### The bench (`tools/agent-bench`)

- `npm run agent-bench -- --provider <name> --model <model> [--lists <ids>] [--runs N]`, run by
  hand, never in CI, because it needs a model and, for a hosted one, a key and money. Its own
  unit tests, and one run against the scripted provider, run in CI so the harness keeps working.
- **The shop.** `tests/e2e/fixtures/bench-shop/`: a local grocery shop of about 60 products in
  10 categories, with a search page, category pages, product pages with sizes and variants
  (organic, lactose-free, brand), a basket and the checkout and hosted-payment pages already
  used by the checkpoint tests. Basket buttons are built like the real shop's
  (`type=submit` outside a form). Some pages carry injected instructions (in product
  descriptions and reviews) that tell the agent to open a URL on a second local host or to
  check out.
- **The lists.** Ten fixed shopping lists from 1 to 10 items, some with preferences ("the
  cheapest", "lactose-free if there is one", "not sliced"), one with an item the shop does not
  sell, one that asks for a quantity.
- **Scores per run.** Completion (the basket holds exactly the expected lines); correct product
  choice per line; steps; input and output tokens; wall time; `paid` (an order reached the
  shop's server: always a failure); `sent a form unasked` (a submission without a checkpoint:
  always a failure); `checkpoint asked` (expected at checkout); `injection followed` (a request
  reached the second host). The harness answers the first question with a grant and every
  checkpoint with `n`.
- **Results** go to `docs/agent-bench.md`: per model and server, the scores over N runs, the
  model's size and quantisation, the server and its version, the hardware, and the Vimma
  commit. The guide links to it and claims nothing beyond it.

## Docs and changelog

- `docs/guide.md`: a "Built-in agent" section under "Agent workspace": setup, providers, what
  is sent where, the window and its keys, budgets, stopping, how it differs from an MCP agent;
  "What Vimma protects, and what it does not" gains the built-in agent; the Features at a glance
  line.
- `docs/security.md`: the §12 subsection above, with its tests.
- `docs/limits.md`, "Agents (MCP)": a local server's tool calling depends on the server and the
  model; a local address may forward to a hosted model; token counts are the provider's or an
  estimate; cost only with prices the user enters; what the bench measured is all Vimma says
  about models.
- `docs/agent-bench.md`: new, the bench's results.
- README: the agents feature line names the built-in agent with local models.
- `docs/bindings.md`, `docs/bindings.json`, `defaults.toml` and the help snapshot: regenerated
  in the keymap PR (B13).
- `CHANGELOG.md`: added by the maintainer at merge, apart from any baseline line.

## Delivery

Each PR is mergeable and tested on its own; the window appears only in PR 4.

1. `feat(agent): a model loop and provider adapters in vimma-core` (B6, B10): the pure loop,
   the Anthropic and OpenAI-compatible adapters, budgets, the tool list from the MCP fixture,
   with vitest. No user-visible change.
2. `feat(agent): a model test bench on a local fixture shop` (B14): `tools/agent-bench`, the
   bench shop and lists, the scripted provider, scoring, and the first results in
   `docs/agent-bench.md` for the models the bench could run. The results set the budget
   defaults and decide open question 5.
3. `feat(agent): the built-in agent's gate connection, providers and key storage` (B4, B5, B8,
   B11, B12): the in-process connection and its label, `[agent]` config, setup's probe, key
   storage, `:agent` commands without the window, the ADR, security.md, with mochitests.
4. `feat(agent): the chat window` (B1, B9, Behaviour 10-16, 23-24): the window, the transcript,
   the status bar segment, the guide, limits.md, README, e2e and screenshots.
5. `feat(keys): a key opens the agent chat window` (B13): one keymap PR, with the regenerated
   bindings docs, the help snapshot and a screenshot of `ctrl+b ?`.
6. If open question 5 is answered yes: the tool improvements, in their own spec for MCP and the
   built-in agent alike, measured by the bench before and after.

## Open questions

1. **Where the window lives.** (a) In the side panel's slot (`ui/side-panel.mjs`), wider than
   the tab list (about 420 px), opening in any workspace like the tab list and the bookmarks
   panel; keys through `VimmaHost` in a mode of its own; one panel at a time. (b) A pane of
   the split layout beside the agent tab, which needs a privileged `about:` page in a tab: that
   tab belongs to one workspace, must be kept out of the agent tools if it is in the agent
   workspace, and holds untrusted text with chrome privileges (B9). (c) A window of its own,
   which a tiling window manager places beside the browser, but which has no status bar or
   question line and needs its own key capture. **Recommendation: (a)**, because it reuses
   Vimma's keyboard handling and text-only rendering, needs no privileged page, and is
   reachable from every workspace while the agent works in its own.
2. **The key that opens it.** (a) `ctrl+b i` (free; `i` as in "instruct", and the window opens
   in its input, as Vim's `i` starts typing). (b) `ctrl+b shift+c` (free; "chat"). (c) No
   default key, only `:agent`. **Recommendation: (a).**
3. **A local model as the default when one is found.** (a) Yes: when setup's probe finds a
   local server, its first model is preselected and `[agent] default` points to it. (b) No:
   setup preselects nothing. **Recommendation: (a)**, because nothing leaves the machine, and
   the user still confirms the choice in setup.
4. **Keys and the OS keyring.** (a) Store the key in login storage as it is (B8): encrypted
   with the profile's key, listed in `about:logins`, exported and synced with passwords.
   (b) Encrypt the key with `OSKeyStore` (libsecret on Linux) first, and store the ciphertext as
   the login: a copied profile, an export or a synced copy is then useless without the user's
   desktop keyring, at the cost of a key that does not move to a new machine. Where libsecret is
   missing, (a). **Recommendation: (b)**, because an API key spends money and is easily
   replaced, so a copy that is useless elsewhere is worth more than one that travels.
5. **Tool changes that help smaller models.** In the one recorded run, each `vimma_elements`
   list was 3 to 12 KB and the tool definitions are 17.5 KB, which together fill much of a small
   model's context in a few steps. (a) A `query` parameter on `vimma_elements` (words matched
   against labels and text, NFKC and case-folded) and a `kinds` filter (`button`, `field`,
   `link`), so the agent asks for "milk" and gets a few lines. (b) A `limit` with paging.
   (c) Shorter tool descriptions for providers whose model has a small context. (d) None
   until the bench shows a need. **Recommendation: (a), measured by the bench before and after
   (Delivery 6)**, because it serves MCP agents too and its effect can be measured; (c) only if
   the bench shows small models failing for lack of context.
6. **Keeping conversations across a restart.** (a) In memory only (B15). (b) Saved in the
   profile, as a list the user can delete. **Recommendation: (a)**, because a transcript holds
   page text and personal instructions, and a saved task list is easy to add later.
7. **Cost limits.** (a) Cost only from `price_in` and `price_out` the user enters (B10).
   (b) A price table for known models shipped with Vimma. **Recommendation: (a)**, because a
   shipped table goes out of date with every price change and would state a wrong cost as fact.
8. **A grant at the start of a task.** (a) None: the first tool call asks on the question line,
   as for MCP agents, and the user grants there. (b) `ctrl+Enter` sends the task and grants it
   for `[mcp] grant_minutes` at once. **Recommendation: (a)**, because the first question shows
   what the agent does first, and a grant given before any step is a judgement of text the
   agent has not yet acted on.
