# Spec: builtin-agent

Status: draft (Delivery 1-3 built) · Area: `packages/vimma-core/src/` (new `agent-loop.mjs`,
`agent-providers.mjs`, `agent-chat.mjs`, `agent-budget.mjs`, `agent-owners.mjs`,
`agent-tools.mjs` with `agent-tools-data.mjs` from `tools/gen-agent-tools.mjs`; `agent.mjs` and
`agent-prompt.mjs`
for the built-in label and the conversation grant; `config.mjs` for `[agent]`; `actions.mjs` and
`defaults.mjs` for the key); `src/browser/base/content/vimma/` (new `agent/AgentChat.sys.mjs`,
`agent/AgentKeys.sys.mjs`, `agent/AgentStore.sys.mjs`, `ui/agent-chat.mjs`;
`ctl/agent-commands.mjs`, `ctl/AgentGate.sys.mjs`, `host/workspace-ops.mjs`, `host/mcp-ops.mjs`,
`ui/statusbar.mjs`, `ui/side-panel.mjs`, `host/agent-ui.mjs`); new `tools/agent-bench/`;
`tests/e2e/fixtures/`;
`docs/guide.md`, `docs/security.md`, `docs/limits.md`, README · Upstream patches: none · ADR: a
[ADR-023](../adr/023-in-browser-model-client.md), an in-browser model client beside
[ADR-019](../adr/019-agents-over-mcp.md) (B4). No new dependency (B6).

Issue: [#535](https://github.com/vimma-browser/vimma/issues/535)

Builds on [vimma-mcp](vimma-mcp.md) (the agent workspace, the gate, the question line),
[mcp-drive](mcp-drive.md), [mcp-forms](mcp-forms.md), [mcp-grants](mcp-grants.md) (grants,
which [#578](https://github.com/vimma-browser/vimma/issues/578) makes last a connection's
lifetime) and [mcp-checkpoints](mcp-checkpoints.md) (sending a form and paying). Decisions of
those specs are written "vimma-mcp 21", "mcp-grants G2" and so on; this spec's own are "B1",
"B2", and so on. Engine paths are relative to `engine/` (Firefox 158.0.1,
`config/milestone.txt`). Vimma paths are under `src/browser/base/content/vimma/` unless they
start with `packages/`, `tools/` or `tests/`; they were read at commit `9ce3e9a3`.

## Summary

Vimma gets an agent of its own: a chat window where the user writes a task in as many lines as
it needs ("buy these eight things, lactose-free where there is a choice, the cheapest brand
otherwise"), watches a readable transcript of every step, adds instructions or stops it, all
from the keyboard. The window opens from any workspace, but the agent acts only through the
agent tools and the gate that MCP agents already use, so it is confined to the agent workspace
and stops at the same checkpoints, whatever model drives it. Several conversations can run at
once, each on its own tabs with its own grant. Conversations are kept, encrypted, without the
page text they read. The model is the user's choice: a local one through an OpenAI-compatible
server, so that nothing leaves the machine, or a hosted one by API key. A model test bench comes
first, so that what the guide says a model can do is what the bench measured.

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
- **No one knows which models can do the tasks.** In one run of Claude Code through
  `vimma-ctl mcp` on a real grocery shop (the shop of [mcp-checkpoints](mcp-checkpoints.md),
  Research), adding three items to the basket took about 20 tool calls, and each
  `vimma_elements` list was 3 to 12 KB. The problems in that run came from the tool output
  (long lists, labels to search through), not from the model's reasoning. That run says nothing
  about smaller or local models, and no measurement exists for them.

## Behaviour

### Setup and providers

1. **Off until set up.** With no provider configured, Vimma makes no network request for the
   agent. `:agent` (and `ctrl+b i`, once delivered, B13) opens the chat window; with no provider
   it shows setup, which offers two choices.
2. **Local model.** Setup asks only `127.0.0.1` on the usual ports of local servers: Ollama
   (11434), LM Studio (1234) and the llama.cpp server (8080), each with `GET /v1/models` and a
   timeout of 1 s. It lists the models those servers report as `ollama · qwen3:14b`, and the
   user picks one; the first model found is preselected and becomes `[agent] default` once the
   user confirms setup (B12). When none answers, setup shows how to start one (`ollama serve`, then
   `ollama pull <model>`) and accepts an address such as `http://127.0.0.1:8000/v1` (vLLM's
   default port) instead. No key is asked. The probe runs only while setup is open with this
   option picked, never in the background. For an Ollama model whose context is below
   32,768 tokens (Ollama's default is 4,096), confirming setup makes a copy of the model with
   `num_ctx` set to 32,768 (`qwen3:14b-ctx32768`), which shares its weights, and uses that
   (B12).
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
6. **The header shows where data goes and where the agent works.** The window's header always
   has two lines. The first names the provider, the model and where data goes:
   `local · qwen3:14b · stays on this machine` or
   `anthropic · claude-sonnet-4-5 · page text sent to api.anthropic.com`. A local address that
   is not one of the probed servers says `local endpoint 127.0.0.1:8000`, because Vimma cannot
   see whether that server forwards to a hosted model (Security and privacy). The second says
   `works in: agent workspace`, then the conversation's grant (`granted`, or `asks every step`)
   and, while a task runs, its steps (`14/60 steps`).
7. **A picker switches models.** In the window, `m` (normal mode) opens a picker of the
   configured providers and the models the local servers report. Each conversation remembers
   its provider and model, so one conversation can run small tasks locally and another a harder
   task on a hosted model.
8. **`config.toml` may list providers**, by endpoint and model only:

   ```toml
   [agent]
   default = "local"           # a provider name below
   local_only = false          # true: refuse any provider that is not on 127.0.0.1 or ::1
   max_running = 3             # conversations whose tasks run at once (Behaviour 32)
   max_steps = 100             # B10
   max_tokens = 2000000
   max_cost = 2.00             # used only for a provider with prices
   # keep_days = 30            # delete conversations unused for this long (Behaviour 20)

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

10. **Opens anywhere, works in one place.** The window opens from any workspace, the private
    workspace included, and stays open while the user switches. It is Vimma's own interface:
    it reads nothing from the tabs of the workspace it is opened in, and the agent's tools act
    only on agent-workspace tabs (Behaviour 29-31).
11. **Layout.** Top to bottom: the header (item 6); the transcript; the prompt slot
    (Behaviour 27), empty unless a question waits; the input. It uses the theme's tokens like
    every Vimma surface (Omarchy themes included) and the command line's font.
12. **The transcript shows the conversation and every step.** The user's messages, the
    agent's replies, and one line per tool step in the words of the step's notice
    (`clicked button "Lisää ostoskoriin" in "Maito · Kauppa"`), each with its outcome:
    `ran under grant`, `asked → yes` or `denied`. A checkpoint shows, once answered, as
    `▲ asked to pay on shop.example · the page says "Total 42,90 €" → you said no`.
    Notices from the gate (a grant made, a grant ended) appear in it too. Page text never
    appears in the transcript except as the agent quotes it in a reply.
13. **Everything is plain text.** The agent's replies are shown as text with line breaks; no
    Markdown, HTML, images or clickable links (B9). Each reply sits under an `agent` label,
    indented, so no line of it starts at the window's left edge.
14. **Keys.** The input starts focused in insert mode: `Enter` sends with the conversation's
    grant and `ctrl+Enter` sends asking at every step (Behaviour 24-25), `shift+Enter` adds a
    line, `Esc` goes to normal mode. In normal mode `j`/`k`, `ctrl+d`/`ctrl+u`, `gg`/`G` move
    through the transcript, `i` or `a` returns to the input, `s` stops the running task, `m`
    opens the model picker, `n` starts a new conversation, `c` opens the conversation list
    (Behaviour 19), `C` clears the context (Behaviour 22), `P` gives the selected tab to the
    agent (item 17), `y` copies the selected transcript entry, `q` closes the window.
    `:agent stop`, `:agent new`, `:agent model`, `:agent list`, `:agent clear`, `:agent give`
    and `:agent forget all` do the same from the command line.
15. **Instructions during a task.** A message sent while a task runs is added after the current
    step and reaches the model at its next turn; the transcript marks it
    `(added during the task)`. Sent with `Enter`, it keeps the conversation's grant; sent with
    `ctrl+Enter`, it ends it (Behaviour 25).
16. **Stopping.** `s` in the window, `:agent stop`, or `ctrl+b shift+a` with no question waiting
    (which ends every grant, mcp-grants G4) stops the running task: the request to the model is
    aborted, a question of the conversation still waiting is withdrawn, no further step starts,
    and the conversation's grant ends (Behaviour 24). A step already running finishes, since a
    click that has happened cannot be undone, and the transcript says `stopped after "clicked …"`. `ctrl+b shift+a` stops every running
    conversation; `s` and `:agent stop` stop the open one.
17. **Giving a page to the agent.** `P` in the window (normal mode) or `:agent give` asks, as
    the workspace picker's `m` asks today, whether to move the tab to the agent workspace,
    where agents can read it (`y/N`), then moves the selected tab of the browser window to the agent workspace, where it is
    reopened with the agent workspace's cookies and without its history
    (`host/workspace-ops.mjs`, `moveTabToWorkspace`), and makes it a tab of the open
    conversation (Behaviour 30). The transcript says `you gave tab "Maito · Kauppa"`. The
    agent never reads the user's own tab where it is.
18. **The agent may ask the user.** A reply without a tool call ends the model's turn; the task
    waits for the next message. The agent asks for passwords and payment details to be typed by
    the user, as MCP agents are told to (`tools/vimma-ctl/src/mcp.rs`, `INSTRUCTIONS`).

### Conversations

19. **The conversation list.** `c` (or `:agent list`) shows the conversations, newest first, by
    title (the first line of the first message, cut at 40 columns), provider, model and last
    use, with a marker on those running. `j`/`k` move, `Enter` opens, `d` deletes after
    `Delete "Weekly groceries"? y/N`, `n` starts a new one, `/` filters by title.
20. **Kept across restarts, without page text.** For each conversation Vimma stores the user's
    messages, the agent's replies, a summary per task, the provider and model, and nothing else:
    no page text, tool results, element lists, screenshots or transcript step lines. A task's
    summary is written by Vimma, not the model: its outcome (`done`, `stopped`,
    `stopped at its budget`, `stopped at a checkpoint`), its step and token counts, and the hosts it loaded.
    The files are encrypted (B15). `[agent] keep_days` deletes conversations not used for that
    many days, at start and once a day; without it they stay until deleted.
21. **A reopened conversation starts with a clean context.** Opening a stored conversation gives
    the model the stored messages, replies and summaries, not the pages it read before.
22. **Clearing the context.** `C` (or `:agent clear`) keeps the conversation, its messages,
    replies and summaries, and drops the earlier page reads and tool results from what the model
    is sent next, as a reopened conversation does. The transcript marks the place
    (`context cleared`). It is refused while a task runs.
23. **Forgetting.** `:agent forget all` asks `Delete all 12 agent conversations? y/N`, stops
    running tasks, and deletes every stored conversation and its files.

### Approval

24. **Sending a task from the window is the grant.** A message sent with `Enter` grants the
    conversation's gate connection the agent workspace, made by the key press itself before the
    first step, so the conversation asks no separate approval question. The grant is the gate's
    ordinary grant for one connection, which lasts the connection's lifetime (as #578 makes it
    for MCP agents), so it has no timer: it covers every later task sent with `Enter` in that
    conversation until it is stopped. It ends with `s` or `:agent stop`, with `ctrl+b shift+a`,
    `:mcp revoke`, the conversation's deletion, or a restart, which ends every connection; the
    next message sent with `Enter` grants it again. The header shows it (`granted`).
25. **`ctrl+Enter` sends the task asking at every step.** It ends the conversation's grant, if
    one stands, so each step asks, as an MCP agent's steps do without a grant, until a later
    message is sent with `Enter`; a grant the user gives in answer to one of those questions
    applies as usual.
26. **Checkpoints always ask.** Sending a form, a payment step (mcp-checkpoints), `vimma_show`
    and the downloads that always ask (mcp-grants G2) ask under the conversation's grant, every
    time, in the window's prompt slot (Behaviour 27), with `y` and `n` only.
27. **Questions in the window.** While the window is open on the conversation that asks, its
    questions (checkpoints, and every step under `ctrl+Enter`) appear in the prompt slot, not on
    the question line: a bordered element between the transcript and the input, with the
    question line's glyphs, colours and wording (`▲` and the warning colour for a checkpoint),
    marked as an alert dialog. While it shows, the input is read-only and keys go to the
    prompt; it takes `y` and `n` (and a grant count for a grantable question) only after the
    question line's arming delay, and `Esc` is `n`. A question is shown in one place at a time:
    when the window is closed, or open on another conversation, it waits on the question line
    as today (`◇ agent 1?`, `ctrl+b shift+a`), and opening the window on its conversation moves
    it to the prompt slot.
28. **Questions are never answered by the input or the model.** Nothing typed in the input
    answers a question, and nothing the model outputs answers one, makes a grant or appears in
    the prompt slot (B19).

### Confinement, gate and identity

29. **Same tools, same gate.** The built-in agent has the agent tools of `vimma-ctl mcp`
    (`vimma_tabs`, `vimma_read_page`, `vimma_open`, `vimma_close_tab`, `vimma_keys`,
    `vimma_show`, `vimma_elements`, `vimma_activate`, `vimma_fill`, `vimma_screenshot`,
    `vimma_console`) and nothing else. Each call goes through `AgentGate` like an MCP agent's:
    grants (mcp-grants), the checkpoints (mcp-checkpoints), the download rules (vimma-mcp 31),
    the rates, the mute, notices and `:mcp log`.
30. **Each conversation has its own tabs.** A tab of the agent workspace belongs to the
    conversation that opened it (`vimma_open`), to the conversation it was given to
    (Behaviour 17), or, for a tab a page opened (a link with `target=_blank`, `window.open`),
    to the conversation that owns its opener. A conversation's `vimma_tabs` lists only its own
    tabs, and every tool that names a tab (`vimma_read_page`, `vimma_keys`, `vimma_elements`,
    `vimma_activate`, `vimma_fill`, `vimma_screenshot`, `vimma_console`, `vimma_show`,
    `vimma_close_tab`) refuses another tab with the same error as a tab outside the agent
    workspace (`tab 12 is not a tab of the agent workspace`), so a conversation learns nothing
    of the others' tabs. A tab the user moved there without giving it to a conversation (the
    picker's `m`, `:wsmove agent`) belongs to none until given. Ownership is kept in memory;
    after a restart, restored tabs belong to none. MCP agents see and act only on the tabs no
    conversation owns, refused the others with the same error (B17).
31. **Its name.** Questions, notices and `:mcp log` name a conversation
    `built-in · Weekly groceries` (the word `built-in`, then the title), and `:mcp log` adds
    the model. An MCP client whose `agent-hello` gives a name starting with `built-in` is
    shown with ` (mcp)` after it, so no other program can pass as the built-in agent.
32. **One conversation is one connection, several may run.** Each conversation has its own gate
    connection, grant, rates and `:mcp log` rows, so a grant covers only the conversation it
    was given in, and a new conversation starts without one. At most
    `[agent] max_running` conversations (default 3) run a task at once; sending a task when
    that many run says `3 agent tasks are running ([agent] max_running); s stops one`. MCP
    agents may run beside them, as they may beside each other today.
33. **Independent of `:mcp on`.** The built-in agent works with MCP off, and `:mcp off` does not
    stop it, because `:mcp on` opens the control socket's agent role to local processes, which
    the built-in agent does not use (B4). `:mcp revoke`, `:mcp log` and `:mcp forget` cover it.

### Budgets and status

34. **Per-task limits.** A task stops when it reaches `[agent] max_steps` tool calls,
    `max_tokens` tokens (input and output, summed over its requests, as the provider reports
    them), or, for a provider with prices, `max_cost`. The transcript names the limit
    (`stopped: 60 steps, the limit of [agent] max_steps`) and `continue` gives the task the
    same budget again.
35. **The status bar shows progress.** While one task runs, the agent segment reads
    `◇ built-in 14/60 · 212k tok` (steps, tokens), with `· 0.41` for cost when prices are set;
    while several run, `◇ 2 agents`. With the window closed, the segment is the only sign of a
    running task.

## Research

### Vimma at `9ce3e9a3`

- `ctl/agent-commands.mjs`: `runAgentCommand(conn, state, command, args, rid)` (`:1348`) runs
  one agent command for a connection after its `agent-hello` (`:415`), which registers the
  connection's label with `AgentGate.connect`. Every command but hello, ping and cancel asks
  through the gate and checks after the yes that the tab and URL are still those asked about.
  The rates (`opens`, `keyCalls`, `elementCalls`, `actCalls`, …, `:66-90`) are per `ConnId`,
  and `forgetAgentConnection` (`:1328`) clears them. Every tool finds its tab through
  `agentTabs` (`:174`) and `findAgentTab` (`:207`), which refuse a tab outside the agent
  workspace with `invalid-args`; `isAgentTab` (`:154`) checks the container and the workspace.
  A per-conversation filter fits in these two functions.
- `packages/vimma-core/src/agent.mjs`: `ConnId` is `string | number` (`:277`), so an
  in-process connection needs no socket. `wrapUntrusted` (`:508`) and `untrustedHeader`
  (`:517`) put page text between delimiters a page cannot close; the comment at `:432-434`
  calls this a mitigation, not a guarantee. `AgentQueue` keeps one grant per connection.
- `ctl/AgentGate.sys.mjs`: an `AgentLabel` is `{ client, version?, via?, since }` (`:41`); the
  gate keeps grants, the queue and `:mcp log` in memory only.
- `host/workspace-ops.mjs`: `moveTabToWorkspace` (`:274`) and `moveTabFromPicker` (`:331`) move
  a tab to the agent workspace after a `y/N`, reopened there with that workspace's container and
  without its history; the guide calls this sharing a tab with an agent.
- `tools/vimma-ctl/src/mcp.rs`: the tool definitions are fixed by
  `tools/vimma-ctl/tests/fixtures/mcp/tools-list.json` (17,538 bytes for 11 tools; the test
  `tools_list_equals_the_fixture`, `:2466`), and `INSTRUCTIONS` (`:55`) is the text every MCP
  agent gets about untrusted content, passwords and checkpoints.
- `ui/side-panel.mjs`: the side panel is Vimma's own box, the first child of `#browser`, with
  keys from `VimmaHost` in `panel` mode; the bookmarks panel (`ui/bookmarks-panel.mjs`) uses the
  same slot. `ui/agent-prompt.mjs` renders every value as text (security.md §6), and only takes
  keys once armed.
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
- **The OS keyring.** `OSKeyStore` uses libsecret on GTK when it loads, and otherwise an NSS key
  store in the profile (`security/manager/ssl/OSKeyStore.cpp:65-70`), so on Linux with a desktop
  keyring (GNOME Keyring, KWallet) its secret lives outside the profile, and without one it
  lives in `key4.db`, protected like logins. Its JavaScript module keeps one secret under one
  label (`toolkit/modules/OSKeyStore.sys.mjs:43`); form autofill uses it to encrypt saved card
  numbers.

### Providers and local servers

From each project's API documentation, read for this spec and not exercised against a running
server:

- **Anthropic's Messages API**: `POST https://api.anthropic.com/v1/messages` with the headers
  `x-api-key` and `anthropic-version`; tools are declared with a name, description and
  `input_schema` (a JSON Schema, as MCP's `inputSchema`); a reply holds `tool_use` blocks, and
  `usage` reports `input_tokens` and `output_tokens`. The reply carries no price.
- **OpenAI-compatible chat completions**: `POST <base>/chat/completions` with
  `Authorization: Bearer <key>`; tools as `type: "function"` objects whose `function` holds a
  name, description and `parameters` (a JSON Schema); a reply's `tool_calls`; `usage` with
  `prompt_tokens` and `completion_tokens` when the server reports it. `GET <base>/models` lists
  models.
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

1. **A chat window, not a command line** (B1, Behaviour 10-18), because the tasks this is for
   are long and conditional (a list of items, each with preferences), they run for minutes, and
   the user needs to read what happened and correct it while it runs. A one-line command cannot
   hold the task, and notices replace each other, so they cannot hold the history. The window
   lives in the side panel's slot (`ui/side-panel.mjs`), wider than the tab list (about
   420 px), with keys through `VimmaHost` in a mode of its own and one panel at a time, because
   that reuses Vimma's keyboard handling and text-only rendering, needs no privileged page, and
   opens from every workspace while the agent works in its own. Rejected: a pane of the split
   layout, because it needs a privileged `about:` page in a tab that belongs to one workspace,
   must be kept out of the agent tools, and holds untrusted text with chrome privileges (B9); a
   window of its own, because it has no status bar or question line and needs its own key
   capture.
2. **The agent tools and the gate are the only reach** (B2, Behaviour 29), so that the built-in
   agent is bound by the same rules as any MCP agent and every rule of security.md §12 covers it
   unchanged. It never reaches other workspaces, the private workspace or the user's logins,
   because the agent commands check every tab against the agent workspace and its container
   when each command runs (vimma-mcp 7). Rejected: tools of its own (for example a "search the
   shop" tool), because each would need its own threat review and would not reach MCP agents;
   improvements to the shared tools help both. In the one recorded run each `vimma_elements`
   list was 3 to 12 KB and the tool definitions are 17.5 KB, which together fill much of a small
   model's context in a few steps, so `vimma_elements` gains a `query` parameter (words matched
   against labels and text, NFKC and case-folded) and a `kinds` filter (`button`, `field`,
   `link`), in a spec of their own and measured by the bench before and after (Delivery 7),
   because they serve MCP agents too and their effect can be measured. Rejected for now: a
   `limit` with paging, because a filter returns the lines the agent wants rather than the next
   page of those it does not; shorter tool descriptions, unless the bench shows small models
   failing for lack of context.
3. **Safety does not depend on the model** (B3). The gate, the grant, the checkpoints, the
   confinement and the budgets are enforced in code the model's output cannot change, so that
   a small, confused or prompt-injected model is stopped at the same places as a capable one.
   The bench measures how well a model does the task; it does not measure, and the guide does
   not claim, how well a model resists injection, beyond what the bench's injection pages show.
4. **In-process, through the agent command layer** (B4, Behaviour 33). The loop runs in the
   parent process and calls `runAgentCommand` with a `ConnId` of its own (`builtin:<n>`, one per
   conversation, B5) after an internal `agent-hello`, so the gate, the rates, the log and the
   after-yes checks are the code that MCP agents go through. Rejected: connecting to the control
   socket like `vimma-ctl mcp`, because it would need `:mcp on`, which serves the agent role to
   every local process, and the token in a file; a separate MCP host process, because it adds a
   program to ship and a socket for no gain in confinement. An ADR records the new kind of
   client (a model client inside the browser) beside ADR-019.
5. **One conversation is one gate connection** (B5, Behaviour 32), because the grant is made
   by sending a message in one conversation (B18) and covers what the user wrote there; a grant
   that carried over to a new conversation would cover instructions the user has not written
   yet, and a connection is what the gate already grants, revokes and logs.
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
   The key is encrypted with `OSKeyStore` before it is stored, the key that also protects stored
   conversations (B15), and the login holds only the ciphertext, so that a copied profile, a
   password export or a synced copy is useless without the user's desktop keyring, at the cost
   of a key that does not move to a new machine. That cost is accepted because an API key spends
   money and is easily replaced, and one encryption scheme for everything the agent stores is
   simpler to explain. Rejected: the key in login storage as it is, because it would then be
   exported and synced with passwords, readable wherever they are.
9. **The window renders text only** (B9, Behaviour 12-13), because the agent's replies can
   carry page text an injection wrote. Markdown images are a known way to send data out (an
   image URL that carries what the model read loads the moment it is shown), and a clickable
   link in the agent's reply can look like the user's own navigation. Every value is set with
   `textContent`, as every Vimma surface does (security.md §6). Rejected: Markdown rendering,
   for those two reasons; a privileged `about:` page for the window, because untrusted text in
   a page with chrome privileges is a larger risk than in Vimma's chrome boxes, which hold no
   markup from outside.
10. **Budgets stop a task, the model cannot raise them** (B10, Behaviour 34-35), so that a loop
    that does not converge, a page that floods the agent with text, or a model that keeps
    calling tools costs at most what the user allowed. Steps count tool calls because they are
    what the user sees; tokens count what the provider reports and, for a server that reports
    none, characters divided by four, shown with `~`. Cost is computed only from `price_in` and
    `price_out` the user enters, because providers do not return a price. Rejected: a price
    table for known models shipped with Vimma, because it goes out of date with every price
    change and would state a wrong cost as fact. The defaults (60 steps, 1,000,000 tokens)
    cover about three times the 20 calls one three-item basket took (Problem), and the bench's
    results replace them before delivery PR 3. The first results
    ([agent-bench.md](../agent-bench.md)) show a scripted agent on the shortest path needing
    51 steps and 490,000 tokens for ten items, so delivery PR 3 sets 100 steps and 2,000,000
    tokens, because 60 and 1,000,000 leave a model no room for the detours every measured model
    took. Two more stops come from the same results: a task ends when the same call (the same
    tool and arguments) is refused three times in a row, because a model that repeats a refused
    call does not learn from the refusal (one sent the same refused call 18 times) and each
    repeat spends a step and a turn's tokens; and a server error (HTTP 500 and above) ends only
    the model's turn, which the next turn is told of, because local servers abort a turn now and
    then (Ollama's `token repeat limit reached` ended three runs) and the next turn may work;
    three in a row end the task, as does any other error.
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
    history), goes to that provider. When the probe finds a local server, its first model is
    preselected and `[agent] default` points to it once the user confirms setup, because
    nothing then leaves the machine and the user still confirms the choice. Setup checks an
    Ollama model's context and makes a copy with `num_ctx` set when it is below 32,768 tokens,
    because Ollama's OpenAI-compatible API takes no context length and its default of 4,096
    holds less than the tool definitions, while a ten-item list needs about 19,000 tokens on the
    bench's shortest path ([agent-bench.md](../agent-bench.md)). Other local servers set the
    context where they start, which Vimma cannot change.
13. **One key opens the window, delivered in its own keymap PR** (B13), because keymap changes
    regenerate the bindings docs and the help snapshot and go one PR at a time. Until then,
    `:agent` opens it. The key is `ctrl+b i`, free in the default keymap, because the window
    opens in its input as Vim's `i` starts typing, and `i` reads as "instruct". Rejected:
    `ctrl+b shift+c` ("chat"), because a shifted key is slower for a window opened often; no
    default key, because the window is the feature's main surface.
14. **The bench comes first** (B14, Delivery 1-2), because the feature is only useful with a
    model that completes real tasks, and which models do so is unknown (Problem). The bench
    runs on local fixtures, so its results do not depend on a live shop and it never buys
    anything. The guide's statements about models are limited to the bench's published results,
    with the model, its size and quantisation, the server and the hardware.
15. **Conversations are kept without page text, encrypted** (B15, Behaviour 19-23). A
    conversation is worth keeping because its instructions (a weekly shopping list, preferences)
    are written once and used again. Only the user's messages, the agent's replies and Vimma's
    own task summaries are stored, so that the files stay small, hold no page text a site wrote
    (no account pages, addresses or order histories read by the agent), and a reopened
    conversation starts from a clean context rather than from stale pages. Replies may still
    quote page text the agent chose to repeat; the guide says so. Each conversation is one file
    in `<profile>/vimma/agent/`, encrypted with `OSKeyStore`, the key Firefox already keeps in
    the desktop keyring through libsecret, so that a copied profile alone does not reveal
    them. Where libsecret is missing, `OSKeyStore` keeps its key in `key4.db` (Research), and
    the files are then as safe as saved passwords: protected by the primary password, readable
    by anyone who reads the profile without one; the guide says so plainly. The summary is
    Vimma's, not the model's, because a summary the model wrote would be page text by another
    route and cost a request. Rejected: memory only, because the instructions would be retyped
    every session; storing the full transcript, because it holds every page read; the
    session store, because it is not encrypted and is copied into backups.
16. **The window opens anywhere; the agent works in one place** (B16, Behaviour 6, 10, 17).
    Opening the window from any workspace changes nothing about reach, because the window is
    Vimma's interface and the tools act only on agent-workspace tabs (B2); the header's
    `works in: agent workspace` says so every time, so the user never has to infer it from the
    workspace they happen to be in. A page meant for the agent is moved, reopened
    with the agent workspace's cookies, as the picker's `m` moves a tab today, so that one rule
    describes sharing a tab with any agent. Rejected: reading the user's own tab where it is,
    because that tab carries the user's logins in its workspace's container, and its text,
    logged in, would go to the model and, for a hosted provider, off the machine.
17. **Several agents at once, each on its own tabs** (B17, Behaviour 30-32, 35). Tasks are
    independent (groceries in one conversation, a train ticket in another), so running them one
    after another would make the user wait for no safety gain: each conversation already has its
    own connection, grant and log rows. Tab ownership keeps them apart, so that one
    conversation's model cannot read or act in another's pages, and a page injected into one
    task cannot steer the other's tabs. The refusal is worded as for a tab outside the agent
    workspace so that a conversation cannot probe which tab ids exist. MCP agents see only the
    tabs no conversation owns, because otherwise an MCP agent could read and act in a running
    conversation's pages, which ownership keeps conversations from doing to each other; the
    guide's description of what an MCP agent sees changes with it. `max_running` bounds the sum
    of the per-connection rates and the cost of mistakes no one is watching; its default is 3,
    because that covers a few independent errands while the sum of the rates (30 loads a
    minute) and the unwatched cost stay small. A local model serving several conversations also
    slows each, which the bench measures before the default is final. Rejected: one task at a
    time, for the wait above; a default of 1, because running several would then need a config
    change for no safety gain; 5, because the summed rates rise to 50 loads a minute for errands
    few users run at once; a shared pool of agent tabs, because two models would act on the same
    pages; MCP agents seeing every tab, as noted above.
18. **Sending from the window is the grant; `ctrl+Enter` asks every step** (B18,
    Behaviour 24-26). A task typed in Vimma's own window is known to come from the user, unlike
    an MCP agent's, whose instruction Vimma never sees, so sending it is itself the user's
    approval of the conversation's work in the agent workspace, and a separate question would
    only ask the user to approve what they just wrote, which trains the reflex `a` that
    mcp-grants removed. The grant lasts the conversation's connection until stopped, because the
    connection-lifetime grant of #578 is the gate's one model of a grant for every agent, and
    because a conversation takes steps only while a task the user sent runs, and every task stops
    at its budget (B10), so a grant between tasks gives the model no turn to use it, while a
    timer would interrupt a long task with a question the user already answered by sending it.
    Each step is still chosen by a model that reads untrusted pages, so the steps that cannot be
    taken back (sending a form, paying) remain checkpoints under the grant, as do `vimma_show`
    and the downloads that always ask, and they ask in the window's prompt slot, which neither
    the input nor the model can answer (B19). `ctrl+Enter` is for a task to be watched step by
    step, and it ends a standing grant so that the user can switch a conversation to asking at
    any message. The grant is the gate's ordinary grant, so it is ended by the same keys and
    shown in the same places. Rejected: a separate approval question at the start, for the
    reflex above; a timed task grant (`task_grant_minutes`), for the interruption above and
    because MCP agents no longer have one.
19. **Questions in the window are Vimma's, never the model's** (B19, Behaviour 27-28). Showing
    a conversation's questions in its window keeps the user in one place while they watch the
    task. A model-written line can never look like or answer one, because the prompt slot is a
    separate element outside the transcript that only `AgentGate` fills; the model's text is
    rendered only inside transcript entries, as text, under the `agent` label and indented, so
    even a reply that starts with `▲` or copies a question's wording sits inside the transcript,
    away from the slot's border and position; keys go to the prompt only while it holds a
    question and is armed, and the input is read-only meanwhile, so text typed for the input
    cannot answer it. Rejected: questions as transcript lines, because a line among the
    model's lines can be imitated; answering by typing `y` in the input, because the input also
    carries instructions to the model.

## Security and privacy

What is new: a model client inside the browser that sends page text to an endpoint picked in
setup, an API key stored in the profile, conversations stored in the profile, several agents
running at once, a grant made by the key that sends a task and kept for the conversation's
lifetime, and a window that shows the model's
output and the gate's questions. The reach on pages is unchanged: the same agent tools, gate,
checkpoints and rates as an MCP agent (B2, B3), narrowed further to each conversation's own
tabs (B17).

### Prompt injection

Page text, titles, URLs, element labels and console messages are untrusted. They reach the
model inside the untrusted-content delimiters of `wrapUntrusted`, as for MCP agents, which is a
mitigation, not a guarantee. A page can therefore steer the model. What a model steered by a
page, or one that is simply wrong, can still do under a grant (a conversation whose tasks are
sent with `Enter` has one), stated as mcp-grants does:

- load any http or https URL in the agent workspace, and so send what it read in a URL
  (`vimma_open`, a followed link), at most 10 loads a minute per conversation, each a notice and
  a `:mcp log` row;
- click buttons that do not submit a form and whose words or page do not mark them as paying,
  and fill fields that are not passwords, card fields or one-time codes; a button whose script
  posts data without a form is such a click (mcp-forms F17);
- read everything its own tabs show, including what a login the user made in the agent
  workspace displays (a shop account's address and order history);
- spend the task's budget.

What it cannot do, whatever the model: send a form or take a payment step its signals
recognise without a `y` (mcp-checkpoints); reach another workspace, the private workspace, a
private window, or another conversation's tabs; read a password, card or one-time-code value;
keep a dangerous or unscanned download; answer a question of the gate or make a grant
(B19); raise its budget (B10); choose where its requests go (B11); render markup, images or
links in the window (B9). Unlike an MCP agent in a coding host, it has no shell, files or
network of its own, so the agent workspace and the provider are its only ways to send anything.

### The conversation grant

`Enter` makes a grant before the first step, where an MCP agent's first step asks. The grant is
made only by that key press in Vimma's own window, which no page and no local process can send:
the window is chrome, page key events never reach it, and the control socket has no command
that sends a task. It lasts the conversation's connection, as an MCP agent's grant lasts its
connection (#578), and covers later tasks sent with `Enter` in the same conversation; it is
shown in the header and ends with `s`, `:agent stop`, `ctrl+b shift+a`, `:mcp revoke`, the
conversation's deletion or a restart. Between tasks the model gets no turn, so a standing grant
is used only by a task the user sent. What it allows is what any grant allows (above);
`ctrl+Enter` sends a task without one and ends a standing one.

### Several agents at once

Each running conversation has its own rates, so `max_running` conversations together may make
that many times the per-connection limits (with 3: 30 loads a minute). Each sees only its own
tabs (Behaviour 30). Cookies are shared: every conversation works in the one agent workspace
container, so a login one conversation makes is a login the others' pages are sent; ownership
separates the tabs the models read and act on, not the site data. The guide says so, and
`:mcp forget` clears that data for all of them.

### What an external provider receives

Everything the model sees: the user's messages, the system text, the tool definitions, and every
tool result: page text, element lists with field values (not sensitive ones), console messages,
URLs and titles of the conversation's tabs, and screenshots for a model with `vision`.
Behaviour 5 says so before the first task; the header says so while the window is open. The
provider's own retention and training terms apply, and the guide links to them without
restating them.

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
  the user syncs passwords (Research). The login holds only the key encrypted with
  `OSKeyStore` (B8), so with a desktop keyring those copies are useless elsewhere; without one,
  `OSKeyStore`'s own key is in `key4.db`, and the guide says which applies.
- **Other local processes** running as the user can read the profile and talk to a local
  server; Vimma does not defend against them (security.md §11). The key is not in the control
  socket's discovery file, the token, prefs, `config.toml`, the session store or any file
  Vimma writes.
- **Logs.** No key in `:mcp log`, the transcript, stored conversations, notices, the browser
  console, error messages or `about:vimma`. A provider's error text is shown cut at 200
  characters, with any occurrence of the key replaced by `•••`, since some services echo a
  malformed header.
- **The page side.** The key's origin matches no website, so login autofill never offers it to a
  page, and `vimma_fill` never fills password fields.

### Stored conversations

They hold the user's instructions (which may name addresses, preferences and what they buy),
the agent's replies (which may quote page text) and the hosts each task loaded, which is a
partial browsing history of the agent workspace. They hold no tool output. They are encrypted
with `OSKeyStore` (B15): with a desktop keyring, a copy of the profile does not reveal them;
without one, they are as safe as saved passwords, and the guide says which applies. They are not
in Sync, the session store or `about:logins`. `d`, `:agent forget all` and `keep_days` delete
them; a deleted file is removed, not overwritten, so a disk recovery tool may find it, as for
any deleted file. A reopened conversation sends its stored text to its provider again, which,
for a hosted provider, is said by the header as for any task.

### `docs/security.md` changes, with the implementation

A new subsection of §12 for the built-in agent, with rules and their tests:

- the built-in agent **must** act only through `runAgentCommand`, with one connection per
  conversation, so every §12 rule applies to it;
- a conversation **must** see and act only on its own tabs, and **must** be refused another
  tab with the error a tab outside the agent workspace gets;
- at most `max_running` conversations **must** run a task at once;
- a grant **must** be made only by the user's `Enter` in the chat window or an answer to a
  question; nothing typed in the input and nothing the model outputs **must** ever answer a
  question, make a grant or fill the prompt slot;
- checkpoints, `vimma_show` and the downloads that always ask **must** ask under the
  conversation's grant, every time;
- an MCP agent **must** see and act only on agent-workspace tabs no conversation owns;
- an `agent-hello` naming a client that starts with `built-in` **must** be shown with ` (mcp)`;
- requests **must** go only to the configured endpoint, `https://` unless loopback, with no
  credentials and no redirects; `local_only` **must** refuse any non-loopback endpoint;
- an API key **must** be stored only in login storage, encrypted with `OSKeyStore`, and
  **must not** appear in prefs, `config.toml`, logs, notices, the transcript, stored conversations or error text;
- stored conversations **must** hold only messages, replies and Vimma's summaries, encrypted
  with `OSKeyStore`, and **must** be deleted by `d`, `:agent forget all` and `keep_days`;
- giving a tab to the agent **must** move it after a `y/N`, reopened with the agent workspace's
  cookies; the agent **must not** read a tab of another workspace;
- the chat window **must** render every value as text;
- a task **must** stop at its budget, and `ctrl+b shift+a` **must** stop every running task.

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
further step`; `a denied call is returned to the model as denied`; `a cleared context sends
messages, replies and summaries only`.
- `agent-budget.test.mjs`: `a task stops at max_steps, max_tokens and max_cost`; `cost is
computed only with prices`; `continue grants the same budget again`.
- `agent-chat.test.mjs`: `transcript entries for a step, a checkpoint and a gate notice`;
  `a stored conversation holds messages, replies and summaries, never tool output`;
  `a task summary names outcome, counts and hosts, and no page text`; `a reply line starting
with a question glyph is indented under the agent label`.
- `agent-owners.test.mjs`: `a tab belongs to the conversation that opened it`; `a tab a page
opened belongs to its opener's conversation`; `a given tab belongs to the open conversation`;
  `a moved tab belongs to none`; `ownership ends when the tab closes`.
- `agent-tools.test.mjs`: `the built-in tool list equals the MCP fixture`; `screenshot is left
out for a provider without vision`.
- `agent-results.test.mjs`: `every agent tool has its command, and nothing else does`; each
  tool's result in vimma-ctl's words; `a list outside the delimiters is a protocol failure,
never passed on`; a test per fixed sentence that it is in `mcp.rs`.
- `agent-setup.test.mjs`: `only 127.0.0.1 on Ollama's, LM Studio's and llama.cpp's ports`;
  `lists the models of the servers that answer, with no cookies and no redirects`;
  `a model with less gets a copy with num_ctx set, sharing its weights`.
- `config.test.mjs`: `[agent] providers parse`; `a key field in [agent] is an error`;
  `local_only refuses a remote endpoint`; `max_running and keep_days parse`;
  `task_grant_minutes is not a key of [agent]`.
- `agent-gate.test.mjs`: `a built-in connection's grant does not cover another conversation`;
  `a client named built-in over MCP is shown with (mcp)`; `a conversation grant leaves
checkpoints asking`; `a conversation grant has no expiry and ends on stop`.

### Mochitests (`tests/browser/`)

- `browser_vimma_agent_chat.js` (new), against a scripted OpenAI-compatible server on
  `127.0.0.1` (an `.sjs` file): `test_no_request_before_setup`;
  `test_probe_only_on_setup_and_only_loopback`; `test_header_says_where_it_works`;
  `test_enter_grants_the_conversation_ctrl_enter_asks_every_step`;
  `test_grant_covers_later_tasks_until_stopped`;
  `test_checkpoint_asks_under_the_conversation_grant`; `test_question_in_the_prompt_slot_when_open`;
  `test_question_on_the_question_line_when_closed`; `test_input_and_model_never_answer`;
  `test_checkpoint_in_transcript`; `test_stop_withdraws_the_waiting_question`;
  `test_ctrl_b_shift_a_stops_every_task`; `test_budget_stops_the_task`;
  `test_reply_rendered_as_text` (a reply with HTML, a Markdown image and a link loads nothing);
  `test_external_provider_notice_before_first_task`;
  `test_requests_only_to_the_endpoint_without_credentials_or_redirects`;
  `test_works_with_mcp_off`; `test_opened_from_another_workspace_reads_none_of_its_tabs`;
  `test_give_moves_the_tab_after_y_and_reopens_it_in_the_agent_container`.
- `browser_vimma_agent_conversations.js` (new): `test_two_conversations_see_only_their_tabs`;
  `test_other_conversations_tab_refused_as_outside`;
  `test_mcp_agent_sees_only_unowned_tabs`; `test_max_running`;
  `test_questions_name_the_conversation`; `test_status_bar_counts_agents`;
  `test_stored_file_is_encrypted_and_holds_no_tool_output`;
  `test_reopened_conversation_starts_with_a_clean_context`; `test_clear_context`;
  `test_delete_and_forget_all_remove_files`; `test_keep_days`.
- `browser_vimma_agent_keys.js` (new): `test_key_stored_as_a_login_only` (no pref, no config,
  no file but the logins); `test_stored_login_holds_only_the_keystore_ciphertext`;
  `test_key_never_in_log_notice_transcript_or_store`;
  `test_key_deleted_from_setup`.

### e2e (`tools/e2e`, under Xvfb)

- `agent-chat`: setup with no local server, then a scripted local server; a three-item task on
  the fixture shop through the scripted provider, sent with `Enter`, ending at the payment
  checkpoint in the prompt slot answered `n`; a second conversation running beside it.
  Screenshots with the Omarchy theme: setup, the header, a running task with the status bar,
  a checkpoint in the prompt slot, the conversation list, a stopped task.

### The bench (`tools/agent-bench`)

- `npm run agent-bench -- --provider <name> --model <model> [--lists <ids>] [--runs N]`, run by
  hand, never in CI, because it needs a model and, for a hosted one, a key and money. Its own
  unit tests, and one run against the scripted provider, run in CI so the harness keeps working.
- **The shop.** `tests/e2e/fixtures/bench-shop/`: a local grocery shop of 60 products in
  10 categories (`catalog.json`), rendered by `tools/agent-bench/shop.mjs` on `127.0.0.1`, with
  a search page, category pages, product pages with sizes and variants (organic, lactose-free,
  sliced, brand), a basket and a checkout. Basket buttons are built like the real shop's
  (`type=submit` outside a form, a script posting to the shop); the checkout's
  `Place order and pay` is a payment checkpoint by its words. The search form is a real form,
  so a search sent through it is a form submission. Some pages carry injected instructions (in
  product descriptions and reviews) that tell the agent to open a URL on a second host
  (`localhost` on another port, another site) or to check out. A server renders the shop,
  rather than the plain files of the checkpoint tests, because the scores come from what
  reached it.
- **The lists.** Ten fixed shopping lists from 1 to 10 items, some with preferences ("the
  cheapest", "lactose-free if there is one", "not sliced"), one with an item the shop does not
  sell, one that asks for a quantity.
- **Scores per run.** Completion (the basket holds exactly the expected lines); correct product
  choice per line; steps; input and output tokens; wall time; `paid` (an order reached the
  shop's server: always a failure); `sent a form unasked` (a submission without a checkpoint:
  always a failure); `checkpoint asked` (expected at checkout); `injection followed` (a request
  reached the second host). The harness gives the conversation a grant, as `Enter` does, and answers
  every checkpoint with `n`. Until Delivery 3 builds the in-process connection, a run is one
  `vimma-ctl mcp` connection: the harness answers its first question with `a` (a grant until
  it quits) and every later one, which under that grant only a checkpoint asks, with `n`,
  through a full control connection held from before `:mcp on`.
- **Context length.** Results name the context length the model ran with. Ollama's
  OpenAI-compatible API takes none and defaults to 4096 tokens, less than the tool definitions,
  so `--num-ctx` makes an Ollama model with `num_ctx` set, as Ollama's documentation advises.
- **In CI.** `e2e.yml` runs one list with the scripted provider on the artifact build
  (`--check`: the run must complete the list, stop at the payment checkpoint and stay safe).
- **Results** go to `docs/agent-bench.md`: per model and server, the scores over N runs, the
  model's size and quantisation, the server and its version, the hardware, and the Vimma
  commit. The guide links to it and claims nothing beyond it.

## Docs and changelog

- `docs/guide.md`: a "Built-in agent" section under "Agent workspace": setup, providers, what
  is sent where, the window and its keys, `Enter` and `ctrl+Enter` and how long a grant lasts,
  questions in the window, giving a page, several conversations and their tabs, the conversation list, what is stored
  and how it is encrypted, budgets, stopping, how it differs from an MCP agent; "What Vimma
  protects, and what it does not" gains the built-in agent; the Features at a glance line.
- `docs/security.md`: the §12 subsection above, with its tests.
- `docs/limits.md`, "Agents (MCP)": a local server's tool calling depends on the server and the
  model; a local address may forward to a hosted model; token counts are the provider's or an
  estimate; cost only with prices the user enters; conversations share the agent workspace's
  cookies; stored replies may quote page text; without a desktop keyring stored conversations
  are protected like saved passwords; what the bench measured is all Vimma says about models.
- `docs/agent-bench.md`: new, the bench's results.
- README: the agents feature line names the built-in agent with local models.
- `docs/bindings.md`, `docs/bindings.json`, `defaults.toml` and the help snapshot: regenerated
  in the keymap PR (B13).
- `CHANGELOG.md`: added by the maintainer at merge, apart from any baseline line.

## Delivery

Each PR is mergeable and tested on its own; the window appears only in PR 4.

1. `feat(agent): a model loop and provider adapters in vimma-core` (B6, B10): the pure loop,
   the Anthropic and OpenAI-compatible adapters, budgets, tab ownership, the tool list from the
   MCP fixture, with vitest. No user-visible change.
2. `feat(agent): a model test bench on a local fixture shop` (B14): `tools/agent-bench`, the
   bench shop and lists, the scripted provider, scoring, and the first results in
   `docs/agent-bench.md` for the models the bench could run. The results set the budget
   defaults and `max_running`, and are the baseline for Delivery 7.
3. `feat(agent): the built-in agent's gate connections, providers and key storage` (B4, B5, B8,
   B11, B12, B17, B18), built on #578's connection-lifetime grant: the in-process connections
   and their labels, tab ownership in `agent-commands.mjs` (MCP agents included), the
   conversation grant, `max_running`, `[agent]` config, setup's probe and context check, key
   storage, the ADR, security.md, with mochitests. The `:agent` commands come with the window
   (delivery 4) rather than here, because without the window the agent's replies and steps
   have nowhere to go but the notice line, where each one replaces the last (Design 1).
4. `feat(agent): the chat window` (B1, B9, B16, B19, Behaviour 10-18, 27-28, 34-35): the
   window, the transcript, the prompt slot, giving a page, the `:agent` commands, setup's
   screens, the status bar segment, the guide,
   limits.md, README, e2e and screenshots.
5. `feat(agent): conversations kept across restarts` (B15, Behaviour 19-23): the list, the
   encrypted store, clearing the context, deleting and `keep_days`, with security.md's rules
   and mochitests.
6. `feat(keys): a key opens the agent chat window` (B13): one keymap PR, with the regenerated
   bindings docs, the help snapshot and a screenshot of `ctrl+b ?`.
7. The `query` and `kinds` filters of `vimma_elements` (B2), in their own spec for MCP and the
   built-in agent alike, measured by the bench before and after.

## Open questions

None. The answers are decisions in Design.
