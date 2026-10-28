# Spec: mcp-session-grants

Status: implemented · Area: `packages/vimma-core/src/` (`agent.mjs`, `agent-prompt.mjs`,
`statusbar.mjs`, `config.mjs`, `defaults.mjs`, `control.mjs`); `src/browser/base/content/vimma/`
(`ctl/AgentGate.sys.mjs`, `ctl/agent-commands.mjs`, `ctl/VimmaControl.sys.mjs`,
`host/agent-ui.mjs`); `tools/vimma-ctl` (`src/mcp.rs`, `src/mcp_serve.rs`, `src/client.rs`) ·
Upstream patches: none · ADR: [ADR-019](../adr/019-agents-over-mcp.md) (unchanged: the gate stays
in the browser; this spec changes how long one answer lasts). No new dependency.

Issue: [#578](https://github.com/vimma-browser/vimma/issues/578)

Builds on [vimma-mcp](vimma-mcp.md) (the gate, grants and their limits, decisions 20-22 and 40),
[mcp-grants](mcp-grants.md) (one grant covers every tool of its connection, G1-G7) and
[mcp-checkpoints](mcp-checkpoints.md) (sending a form and paying ask under any grant). Decisions
of those specs are written "vimma-mcp 21", "mcp-grants G1"; this spec's own are "S1", "S2", and
so on. Vimma paths are under `src/browser/base/content/vimma/` unless they start with
`packages/`, `tools/` or `tests/`.

## Summary

One approval lets an agent work for its whole session. Answering `a` to an agent's first
question now allows that agent until it quits, instead of for ten minutes, and a dropped link
that the same `vimma-ctl mcp` process reconnects within two minutes keeps the approval. The
checkpoints still ask every time: sending a form, paying, showing a page, a download Vimma
cannot vouch for, and full control. The MCP server stops telling models that every call waits
for the user.

## Problem

A grant lasted `[mcp] grant_minutes` (10 by default, a count up to 480), and every new
`vimma-ctl mcp` process, restart of the agent or dropped link asked again.

- **A task outlives ten minutes.** An agent that shops, books or researches for the user works
  for longer than ten minutes, often while the user does something else. When the grant ended,
  the next call asked again; the user was not watching, the question timed out after
  `ask_timeout` (50 s), the call was denied, and the agent stopped mid-task or retried and
  asked again. The user then had to come back, answer, and tell the agent to continue.
- **A dropped link lost the grant.** Vimma closes an agent connection after 60 s without a
  line (vimma-mcp 40). A suspended laptop, or an agent host that pauses its MCP server process,
  misses the 30 s ping, so the link drops and the next call connects as a new connection with
  no grant, though it is the same agent process that holds the grant.
- **The server's instructions made models check in.** `vimma-ctl mcp` told the model "Every call
  waits until the user answers in Vimma (once, for some minutes, or no) ..., so tell the user
  what you are about to do", and each tool's description said "Vimma asks the user first". A
  model that reads this stops before each call to tell the user what it is about to do, even
  under a grant, which turns one approval back into a conversation per call.

## Behaviour

1. **A bare `a` allows the agent until it quits.** With `[mcp] grant_minutes = 0`, the new
   default, `a` in answer to a grantable question grants that connection every agent tool with
   no time limit (mcp-grants G1 for the scope). The question's hint reads
   `y once · a until it quits · n deny · x mute`. The grant's notice reads
   `claude-code may use the agent workspace until it quits; sending a form or paying still asks (ctrl+b shift+a ends it)`.
2. **A count still gives minutes.** `10a` grants 10 minutes, capped at
   `[mcp] grant_max_minutes`, as before. With `grant_minutes` above 0 a bare `a` grants that
   many minutes and the hint reads `y once · 10a 10 min · n deny · x mute`, as before.
3. **Visible while it runs.** The status bar's agent segment shows `◇ agent granted` while a
   grant with no time limit runs (`◇ agent 14m` for a timed one). A call under it shows its
   notice without minutes: `claude-code opened docs.rs (grant)`. `:mcp` says
   `· 1 grant, until its agent quits` (`· 2 grants, until their agents quit`).
4. **A reconnect keeps the grant.** Each `vimma-ctl mcp` process makes a random session id at
   start and sends it in every `agent-hello`. When an agent connection holding a grant closes,
   Vimma keeps the grant for 2 minutes; the first new connection whose hello carries the same
   session id gets it back, with the same end. After 2 minutes, or for any other session id, or
   for a connection without one, the next call asks.
5. **What ends a grant.** The connection closing for more than 2 minutes, `ctrl+b shift+a`
   with no question waiting, `:mcp revoke`, `:mcp off` (the grants of open connections and the
   ones waiting for a reconnect), Vimma quitting, and, for a timed grant, its time.
6. **Unchanged.** Sending a form, paying, `vimma_show`, a dangerous or unscanned download, a
   page's own download and full control ask every time under any grant (mcp-grants G2,
   mcp-checkpoints C1). The rate limits, the queue limits and the mute (vimma-mcp 17-18) hold
   as before. `x` mutes a connection until it reconnects, as before.
7. **The MCP instructions.** `vimma-ctl mcp`'s server instructions say that the first call asks
   the user once for the session, that once allowed the model carries on without checking in
   before each call, and that showing a page, sending a form, paying and some downloads still ask
   every time. Each tool's description says "Unless the user allowed this session, Vimma asks
   them first". A call that fails because the link dropped says that the next call keeps the
   session's grant if it comes within two minutes.

## Research

### Vimma at `271f7e42`

- `packages/vimma-core/src/agent.mjs`: `AgentQueue` holds one grant end per connection
  (`conns`), dropped in `disconnect`; `grantLength` turned a bare `a` into `grant_minutes`
  minutes. `ALWAYS_ASK` and the `always` option are what keep the checkpoints asked under any
  grant; this spec does not touch them.
- `ctl/AgentGate.sys.mjs`: `connect` and `disconnect` are called from `ctl/agent-commands.mjs`
  (`agent-hello`) and `ctl/VimmaControl.sys.mjs` (`close`). `:mcp off` reaches the gate through
  `apply` in `ctl/VimmaControl.sys.mjs`, which clears `:mcp log` before the server closes the
  agent connections.
- `tools/vimma-ctl/src/mcp_serve.rs`: one link per process, opened lazily at the first call and
  again at the first call after a drop; an `agent-ping` every 30 s keeps it open. The process
  already reads `/dev/urandom` for the handshake nonce (`client.rs`, `random_nonce`).
- `tools/vimma-ctl/src/mcp.rs`: `INSTRUCTIONS` and the tool descriptions held the wording quoted
  under Problem.

### Other browsers' agents

[mcp-grants](mcp-grants.md), Research, lists how other browsers' agents confirm: each pauses
before a purchase, a post or a sensitive site, and none asks again on a timer while a task runs.
That matches this spec: a task is approved once, and only the steps with consequences ask.

## Design

1. **A grant lasts the agent's session by default** (S1, behaviour 1), because the user judges a
   task when they approve it, and a task runs as long as the agent does; a timer that ends the
   grant mid-task asks while the user is away, the question times out, and the agent fails or
   asks again, which is the prompt fatigue vimma-mcp 18 guards against. The session is the
   connection of one `vimma-ctl mcp` process, which the agent host starts with the agent and
   ends with it. Rejected: a longer default (60 minutes), because any fixed length is either too
   short for a long task or longer than a short one needs, and still interrupts the long one.
2. **`grant_minutes` stays, as an opt-in limit** (S2, behaviour 2), because a user who watches a
   short task or distrusts an agent may want its approval to lapse on its own; `0` (the default)
   means the whole session, so a config that sets `grant_minutes = 10` keeps working and keeps
   its meaning, and a count before `a` is still a one-off timed grant. Rejected: removing
   `grant_minutes`, because existing config files that set it would then fail validation.
3. **A reconnect of the same process keeps its grant for 2 minutes** (S3, behaviour 4), because a
   dropped link of the same process is the same agent the grant was given to: the session id is made
   by that process and known only to it and Vimma. Two minutes covers Vimma's 60 s idle close
   and the agent's next call during a running task; a grant waiting longer would outlive an
   agent that has quit. Rejected: matching on the client name, because any process can claim
   any name (vimma-mcp 21); keeping the grant until Vimma quits, because a grant must not
   outlast its agent by more than a moment; reconnecting eagerly from `vimma-ctl mcp` the moment
   the link drops, because an idle agent need not hold a connection, and the lazy reconnect at
   its next call is enough within the window.
4. **The session id is unguessable and claimed once** (S4, behaviour 4), so that no other
   connection can take a grant: 32 random bytes from `/dev/urandom` as 64 lowercase hex
   characters, sent only inside the authenticated socket, and Vimma accepts 32 to 128 hex
   characters (at least 128 bits). A grant waiting for its session is given back to the first
   connection that names it and to no other; a second connection naming a session that an open
   connection holds gets nothing and parks nothing when it closes. A `vimma-ctl mcp` that cannot
   read random bytes sends no id, and its reconnects ask again. Rejected: deriving the id from
   the process id, because process ids are small and reused.
5. **`:mcp off` and revoking end the waiting grants too** (S5, behaviour 5), because the user
   expects both to end every grant, including that of an agent whose link is down at that
   moment. `:mcp off` also marks the open connections so that, when the server closes them a
   moment later, they park nothing.
6. **The status shows a grant with no end as `granted`** (S6, behaviour 3), because `◇ agent`
   alone means only that an agent is connected, and the user must see that this one may act
   unasked; minutes have no meaning for it, so the notice of a call under it drops them.
7. **The instructions describe the session, not every call** (S7, behaviour 7), because models
   follow the server's instructions literally: "every call waits" makes a model announce each
   call and wait for the user in the chat as well, which defeats the single approval. They keep
   telling the model to say what it is about to do before the steps that still ask, since those
   do wait for the user.

## Security and privacy

What changes: one answer lets an agent use every agent tool, as mcp-grants describes, for as
long as the agent runs, possibly hours, rather than for ten minutes; and a grant survives a
dropped link of the same process for two minutes.

- **Longer exposure to prompt injection and exfiltration** (mcp-grants, Security and privacy).
  A page read late in a long session can steer the agent as one read early could, and under a
  session grant its acts run unasked for longer. What bounds it is unchanged and does not
  depend on time: the agent workspace's container, the checkpoints (form submission, paying,
  show, unsafe downloads, full control), at most 10 opens a minute, a notice and a `:mcp log`
  row for every call, the status bar's `◇ agent granted`, and `ctrl+b shift+a` to end every
  grant at once. A count before `a` gives a timed grant for a task that should stay bounded. The
  guide advises a grant only for a task the user is watching, as before.
- **The session id.** It lets a new connection take over a grant, so it is sent only over the
  token-authenticated socket and never logged or printed. A process that could read it from
  `vimma-ctl`'s memory runs as the same user and can read the control token as well (security.md
  §11), so the id adds no new reach. Vimma rejects ids shorter than 128 bits and gives a waiting
  grant back once.

`docs/security.md` §12: the reach paragraph says what a session grant allows and how it ends;
M5 adds the session id rules.

## Tests

### Vitest (`packages/vimma-core`)

- `agent-gate.test.mjs`: `a grant for the whole connection runs until the connection closes`;
  `a connection without a session asks again after a reconnect`; under `a reconnect of the same
session`: `keeps its grant within RECONNECT_MS`, `keeps a timed grant's end, and not one that
ended`, `asks again after RECONNECT_MS`, `another session, or none, gets nothing, and the
parked grant stays for its own`, `a parked grant is restored once`, `a second connection
claiming a live session gets nothing`, `revoke ends a parked grant too`, `turning MCP off ends
the parked grants and those of the open connections`; `grant_minutes 0: a bare a lasts the
whole connection, a count is still minutes`; `a grant for the whole connection says it lasts
until its agent quits`.
- `agent-prompt.test.mjs`: `with grant_minutes 0 the hint says a lasts until the agent quits`;
  `a grant for the whole connection says it lasts until the agent quits`; `a call under a grant
for the whole connection names no time left`.
- `statusbar.test.mjs`: the agent segment shows `◇ agent granted`.
- `config-v2.test.mjs`: the default `grant_minutes = 0`, and 0 is valid.
- `control-v2.test.mjs`: `agent-hello: a session id of 32 to 128 lowercase hex characters`;
  `tests/contract/control/v2/request-agent-hello-session.{valid,invalid}.json`.

### Rust (`tools/vimma-ctl`)

- `tests/mcp.rs`: `a_dropped_connection_fails_the_waiting_call_and_the_next_call_reconnects`
  (both hellos carry the same session id); `each_process_has_its_own_session_id`.
- `src/mcp.rs`: `the_instructions_say_the_first_call_asks_once_and_checkpoints_ask`;
  `the_tools_say_a_call_asks_only_until_the_user_allowed_the_session`;
  `failures_say_what_the_user_or_the_model_must_do` (the dropped link's text);
  `tools_list_equals_the_fixture`.

### Mochitests (`tests/browser/`)

- `browser_vimma_mcp_agent.js`: `test_a_reconnect_of_the_same_session_keeps_its_grant`: a bare
  `a` grants with no end, a reconnect with the same session id reads unasked, another session
  asks, and after `:mcp off` and on the same session asks.

## Docs and changelog

- `docs/guide.md` "Agents (MCP)": the keys table, "Grants are wide", the status bar and `:mcp`
  lines, and the `[mcp]` config comment.
- `docs/security.md` §12 as above.
- Notes in the implemented specs [vimma-mcp](vimma-mcp.md) (decisions 20-22, 40) and
  [mcp-grants](mcp-grants.md) (behaviour 1, 2, 4) say `(Since changed: …; mcp-session-grants.md.)`.
- `CHANGELOG.md`: written by release-please from the commit.

## Delivery

One PR, `feat(mcp): one approval lasts the agent's whole session`: core, gate, protocol,
`vimma-ctl mcp`, tests, security.md, the guide and the spec notes.

## Open questions

None: the default length, the reconnect window and the wording are decided above.
