# Spec: m0-control-protocol-and-vimma-ctl

Status: implemented · Area: `packages/vimma-core/src/control.mjs` (contract validator),
`tools/vimma-ctl` (Rust client), `tests/contract/control/v1/` and `v2/` (fixtures); the server is
[m0-control-server](m0-control-server.md) · Upstream patches: none · ADR:
[ADR-007](../adr/007-control-socket.md), [ADR-011](../adr/011-vimma-ctl-rust.md),
[ADR-019](../adr/019-agents-over-mcp.md)

## Summary

Vimma's control socket lets scripts, window-manager bindings and the e2e harness drive a running
Vimma: `vimma-ctl state`, `vimma-ctl send-keys "ctrl+b c"`, `vimma-ctl open https://example.com`.
This spec is its wire contract (JSON lines over loopback TCP, a token handshake in which the
server proves itself first, versions 1 and 2), backed by JSON fixtures that the browser-side
server's validator and the Rust client both test against, and the client `vimma-ctl` itself.

## Problem

Nothing outside the browser could drive Vimma: no way to script it, bind a window-manager key to
one of its actions, or test a real build end to end. A socket for that needs a contract both
ends can be tested against independently, since the server is JavaScript (ADR-004) and the
client Rust (ADR-011) and they cannot share code, and it must not give the browser to any other
local user or to a web page.

## Behaviour

1. As a Vimma user with `vimma.control.enabled` on, `vimma-ctl send-keys ctrl+b c` presses those
   keys in Vimma as if typed; `vimma-ctl state` prints the mode, pending keys, workspace and
   tabs (`--json` for the raw result); `vimma-ctl open URL` opens a new tab; `vimma-ctl
reload-theme` re-reads the Omarchy theme now.
2. With the pref off (the default), there is no socket and no discovery file, and `vimma-ctl`
   says Vimma's control socket is off (exit 3).
3. `vimma-ctl` finds the profile by itself (`profiles.ini`), or takes `--profile DIR` or
   `VIMMA_PROFILE`, and reports a stale discovery file, an insecure one, a busy server and a
   server that cannot prove the token, each with its own message and exit code.
4. The e2e harness drives a real build through the same client and protocol.
5. With MCP on (protocol 2), an agent tool's `vimma-ctl mcp` speaks the `agent` role, and a new
   `full` connection is welcomed only after the user's `y` ([vimma-mcp](vimma-mcp.md)).

## Research

- Firefox's server socket: `nsIServerSocket.init(port, loopbackOnly, backlog)` binds 127.0.0.1
  when `loopbackOnly` is true and takes `-1` for an OS-chosen port; used as such by the server
  spec ([m0-control-server](m0-control-server.md), which cites the engine paths).
- Profile layout: the `profiles.ini` that Firefox's `nsToolkitProfileService` writes, with its
  `[Install…]` sections; checked against a real profile directory (below, Profile discovery).
- Token files: OpenSSH refuses a private key that group or others can read; the client applies
  the same rule to the discovery file, for the same reason (the file holds a secret).

## Design

Scope: version 1 of the protocol with JSON fixtures in `tests/contract/control/v1/` (one valid
and one invalid file per message type); `packages/vimma-core/src/control.mjs`, a pure validator
for every message and the discovery file plus `tokensEqual` (constant-time token comparison),
which the server imports; `tools/vimma-ctl/`, the Rust client, std only (ADR-011), whose JSON
module rejects duplicate keys, lone surrogates and nesting deeper than 64; protocol 2 (roles),
whose fixtures are in `tests/contract/control/v2/`.

### Protocol, version 1

#### Transport

- TCP on `127.0.0.1` only (`nsIServerSocket.init(-1, /* loopbackOnly */ true, backlog)`), a
  random port chosen by the OS. Never `0.0.0.0`, never `::`.
- UTF-8 **JSON lines**: every message is one JSON object on one line, terminated by `\n`
  (a preceding `\r` is tolerated). No other framing.
- A line longer than **1 MiB** is an error: the server answers `bad-request` and closes.
- One connection carries one handshake and then any number of requests. Requests are answered in
  the order received; every response carries its request's `id`, so a client may pipeline.
- Clients and servers **must ignore unknown fields in results** (`result`, `welcome`): adding a
  field is a compatible change within version 1. Removing or renaming one needs version 2.
  Requests are strict: unknown `args` fields are `invalid-args`, so typos fail loudly.

#### Discovery file

When the server starts it writes `<profile>/vimma-control.json`, mode **0600**, atomically
(write `vimma-control.json.tmp` with 0600, then rename), and deletes it on shutdown:

```json
{ "protocol": 1, "port": 43817, "token": "<64 lowercase hex chars>", "pid": 12345 }
```

- `protocol`: integer, the highest protocol version the server speaks.
- `port`: integer 1..65535.
- `token`: 32 bytes from a CSPRNG (`crypto.getRandomValues`), lowercase hex, new every start.
- `pid`: integer ≥ 1, the browser's parent process; lets a client report a stale file
  (a crashed browser cannot delete it).

Clients refuse a discovery file readable or writable by group or others (`mode & 0o077 != 0`),
like `ssh` with a private key, and say how to fix it. A stale file (nothing listening) is reported
as "Vimma is not running (or the control socket is off)". On Linux the client also checks that
`pid` is alive (`/proc/<pid>`) and reports a stale file when it is not. The server removes any
file at that path when it starts (whatever the pref) and when it stops.

#### Handshake

Four lines, in this order; anything else, or no `welcome` within 5 s of connecting (one deadline
for the whole handshake), closes the connection with an error. The server proves it knows the
token **before** the client sends it.

1. Client: `{ "type": "hello", "protocol": 1, "nonce": "<64 hex>" }`. `nonce`: 32 fresh bytes
   from a CSPRNG per connection, lowercase hex. **No token**: a `hello` with a `token` is
   `bad-request`.
2. Server: `{ "type": "challenge", "protocol": 1, "proof": "<64 hex>" }`, where
   `proof` = HMAC-SHA256(key: the token, message: `"vimma-server\0"` + the nonce), ASCII
   (vimma-core `CHALLENGE_CONTEXT`), in lowercase hex. The prefix separates this use of the token
   from any other, so a proof the server hands to an unauthenticated client is good for nothing
   else.
3. Client: compares the proof with its own in constant time. On a mismatch it closes and sends
   **nothing more**: neither the token nor a command. Otherwise `{ "type": "auth", "token": "<token
from the discovery file>" }`.
4. Server: `{ "type": "welcome", "protocol": 1, "app": "Vimma", "version": "0.1.0" }`.

Fixtures: `challenge.valid.json` answers `hello.valid.json` for the token of `auth.valid.json`.

**What this guarantees.** A process squatting on a stale discovery file's port (the browser
crashed; another local user bound the port) learns only the nonce: it cannot produce the proof,
so it never receives the token or a command (`vimma-ctl` exits 4). It does not stop a squatter
from making the client wait (no reply: the client's timeout ends it) or from learning that a
client tried to connect.

**Why this is version 1 and not 2.** The order above (proof before token) was fixed before any
server shipped, once a security check found that an earlier form, which sent the token in the
`hello` next to the nonce, let a squatter compute the proof itself. `vimma-ctl` and the e2e
harness live in the same repository as the server, so no deployed peer speaks that form, and a
version 2 for it would only carry dead compatibility code.

Failure: an error response with `"id": null`, then the server closes the connection:

```json
{
  "type": "response",
  "id": null,
  "ok": false,
  "error": { "code": "unauthorized", "message": "bad token" }
}
```

The server compares tokens with `tokensEqual` (vimma-core), which takes time independent of where
the strings differ. A wrong token (`unauthorized`), a `protocol` the server does not speak
(`unsupported-protocol`), and a malformed or out-of-order line (`bad-request`) all end the
connection. `busy` may come instead of a `challenge` (evicted while waiting) or instead of the
`welcome` (8 authenticated connections).

#### Requests and responses

```json
{ "type": "request", "id": 7, "command": "state", "args": {} }
{ "type": "response", "id": 7, "ok": true, "result": { "...": "..." } }
{ "type": "response", "id": 7, "ok": false, "error": { "code": "invalid-args", "message": "..." } }
```

- `id`: an integer 1 ≤ id ≤ 2^53 − 1 chosen by the client (unique per connection).
- `command`: one of the commands below. `args`: an object, `{}` when the command takes none.
- A response has exactly one of `result` (when `ok` is true) and `error` (when false).
- `error.code` is one of the codes below; `error.message` is a human-readable string.
- An unparseable line or a broken envelope gets an error response with the request's `id` if it
  could be read, else `null`; the connection stays open unless the line was over the limit.

| Error code             | Meaning                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `bad-request`          | not JSON, not an object, or the envelope is malformed            |
| `unauthorized`         | wrong or missing token (handshake only)                          |
| `unsupported-protocol` | the `hello` asked for a version the server does not speak        |
| `unknown-command`      | `command` is not a v1 command                                    |
| `invalid-args`         | `args` does not match the command                                |
| `not-implemented`      | a reserved command (below)                                       |
| `failed`               | the command was valid but could not be carried out (e.g. no tab) |
| `internal`             | a bug in the server; the message says what threw                 |
| `busy`                 | at the connection limit (handshake only; see Security)           |

#### Commands

| Command         | `args`                                                 | `result`                |
| --------------- | ------------------------------------------------------ | ----------------------- |
| `send-keys`     | `{ "keys": "ctrl+b c" }`                               | `{ "sent": 2 }`         |
| `state`         | `{}`                                                   | the state object below  |
| `open`          | `{ "url": "https://…", "where"?: "tab" \| "current" }` | `{ "tab": "<tab id>" }` |
| `reload-theme`  | `{}`                                                   | `{ "changed": true }`   |
| `list-tabs`     | reserved, not implemented: `not-implemented`           |                         |
| `screenshot`    | reserved, not implemented: `not-implemented`           |                         |
| `reload-config` | reserved, not implemented: `not-implemented`           |                         |

**`send-keys`.** `keys` is a whitespace-separated sequence of chords in Herdr notation, exactly
what `parseKey` (vimma-core) accepts: `ctrl+b c`, `g t`, `esc`, `shift+t`. Symbolic `prefix` and
`<leader>` are not accepted: the client sends the literal keys. 1 to 256 chords. The server feeds
each chord to the window's dispatcher as if typed (same path as a real keydown, including mode
handling) and returns how many it sent. A chord that fails `parseKey` is `invalid-args` and none
are sent.

**`state`.** A snapshot of the focused window:

```json
{
  "mode": "normal",
  "pending": "prefix",
  "workspace": null,
  "tabs": [
    {
      "id": "12",
      "url": "https://example.com/",
      "title": "Example",
      "selected": true,
      "loading": false
    }
  ],
  "panes": null
}
```

- `mode`: one of vimma-core's `MODES`.
- `pending`: the pending key sequence as the status bar shows it (the dispatcher's `pending()`
  labels joined by spaces, `"prefix"` after `ctrl+b`), or `null`.
- `workspace`: the active workspace's name, `null` until workspaces exist (filled since M3) or in a
  window without them. A private window is the private workspace: `"private"`
  ([private-workspace](private-workspace.md)).
- `private`: `true` in a private window, absent otherwise. Its tabs' `url` and `title` are then
  `null`, withheld so that scripts never see private pages (private-workspace decision 8d); `id`,
  `index`, `selected`, `pinned`, `loading` and `panes` are kept.
- `tabs`: the window's visible tabs in strip order. `id` is an opaque string, stable for the tab's
  lifetime (the server uses `browser.browserId`); exactly one tab is `selected` when there are any.
  `loading` is `true` while the tab's page loads (the tab strip's busy state, or a document load
  in progress), and in a new window before it has started to load its first page: a window is
  listed as soon as it opens, while its tabs still show their initial empty document. It is
  `false` once the page has loaded or stopped, and for an unloaded tab (restored on demand or
  discarded), which `state` leaves without a browser. It names no page, so a private window
  keeps it; there it is the only sign that the start page has loaded. Added without a version
  bump, like `panes`: a client that waits on it treats a missing `loading` as not loaded.
- `panes`: the pane tree once split view exists (M3), `null` before. Its shape is that spec's to
  define; it is added without a version bump because clients ignore what they do not know.
  Since m3-workspaces sub-spec 7: `null` while the window shows one pane, else
  `{ "focus": "<tab id>", "zoomed": false, "root": <node> }`, where a node is a split
  `{ "axis": "x" | "y", "ratios": [0.5, 0.5], "children": [<node>, …] }` (`x` left to right,
  `y` top to bottom, one ratio per child) or a leaf `{ "tab": "<tab id>", "index": 1 }`: the
  tab's id as in `tabs` and its place there (`-1` if it is not visible). Read-only, like the
  rest of `state`. Since side-panel-unsplit (decision 28) it also has `"hidden": true | false`:
  true while the split is kept as a hidden view and another tab shows alone.

**`open`.** `url` is an absolute URL whose scheme is `http`, `https`, `file` or `about`; anything
else (notably `javascript:` and `data:`) is `invalid-args`. At most 65536 characters. `where`
defaults to `tab` (a new foreground tab); `current` loads it in the selected tab. The result is
the tab's id, as in `state`.

**`reload-theme`** (spec m5-omarchy-theme, "Instant reload"). Re-reads the
Omarchy theme now instead of at the next poll: the same check as the poll (the directory in
`vimma.theme.omarchyPath`, the same strict validation, a rejected file keeps the colours), except
that `colors.toml` is read even when its stat looks unchanged. No args: a client cannot point the
browser at another file. The response comes once every window shows the result; `changed` says
whether the colours differ from before. With `vimma.theme.source` = `builtin` it is a no-op
(`changed: false`). Its whole effect is one early poll: it takes no input, reads only the file
the poll reads anyway, and changes only the theme's token stylesheet.

Adding a command within v1: a v1 client never sends it unasked, and an older server answers it
`unknown-command` (exit 1), which is the right message. No existing message changes shape.

### Protocol, version 2 (roles)

Spec: [vimma-mcp](vimma-mcp.md) (decisions 2-4), ADR-019. Fixtures:
`tests/contract/control/v2/` (v1's are unchanged). The server speaks 1 and 2.

- **Hello.** `{ "type": "hello", "protocol": 2, "nonce": "…", "role": "agent" | "full" }`. The
  role is required in protocol 2 and not allowed in protocol 1, whose hello is the `full` role.
  The challenge and the welcome carry the hello's protocol; a protocol 2 welcome also repeats the
  `role`. Any other protocol is `unsupported-protocol` ("this server speaks protocols 1 and 2").
- **Roles and switches.** `full` runs protocol 1's commands and is served while
  `vimma.control.enabled` is on. `agent` runs only the agent commands below and is served while
  MCP is on (`vimma.mcp.enabled`, `[mcp] enabled`). Either switch starts the server; it stops
  when both are off. A hello for a role that is off is answered `role-off` (its message names
  the switch) and closed, and turning a switch off closes that role's connections. Each role gets
  `unknown-command` for the other's commands.
- **Discovery file.** `protocol` is 2, and `roles` lists the roles served, in the order
  `["agent", "full"]`: `{ "protocol": 2, "port": …, "token": "…", "pid": …, "roles": ["agent"] }`.
  A v1 client reads past `roles` and speaks protocol 1, which works while `full` is served.
  `vimma-ctl` speaks protocol 2 as `full` when the file says 2, and says the control socket is
  off when `roles` lacks `full`, without connecting.
- **Full control while MCP is on** ([vimma-mcp](vimma-mcp.md) decision 29). After a `full`
  connection's auth and before its welcome, Vimma asks the user; a refusal is the error `denied`
  (with its `reason`) in place of the welcome. The auth may carry `"code"`: 4 characters of 2-9
  and A-Z without I and O, which `vimma-ctl` prints on stderr and the question shows, so the
  user answers for the client they ran. `vimma-ctl` sends it, and waits up to 310 s for the
  welcome, only when the discovery file lists `agent`.
- **New error codes.** `role-off` (above) and `denied`: an agent request the user did not allow.
  A `denied` error carries `reason`: `user`, `timeout`, `busy`, `muted`, `changed` or
  `cancelled`; no other error has a `reason`. (Since changed: a `busy` denial for a used-up
  per-connection rate also carries `retryAfter`, the milliseconds until the next call is
  allowed, and its message names the limit; see [security.md](../security.md) M20 and M32.)
- **Agent commands** (role `agent` only; `agent-hello` must come first, and only once):

  | Command        | `args`                                                     | `result`                                                                         |
  | -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
  | `agent-hello`  | `{ "client": { "name", "version"? }, "via"? }`             | `{ "workspace": "agent", "exists": true }`                                       |
  | `agent-tabs`   | `{}`                                                       | `{ "tabs": [{ "id", "url", "title", "loading" }] }`                              |
  | `agent-read`   | `{ "tab", "format"?: "markdown" \| "text", "max_chars"? }` | `{ "url", "title", "text", "truncated", "selection", "language", "background" }` |
  | `agent-open`   | `{ "url", "tab"? }`                                        | `{ "tab": "<id>" }`                                                              |
  | `agent-close`  | `{ "tab" }`                                                | `{ "closed": true }`                                                             |
  | `agent-ping`   | `{}`                                                       | `{}`                                                                             |
  | `agent-cancel` | `{ "id" }`                                                 | `{ "cancelled": true \| false }`                                                 |

  `name` and `version` are 1 to 64 printable characters and `via` 1 to 32 (no control
  characters, no bidirectional marks or overrides). `tab` is a tab id as `state` gives it
  (digits). `url` is http or https only, at most 65536 characters. `max_chars` is 1 to 500000,
  and the server caps it at `[mcp] max_read_chars`. `text` is the page text between
  `<untrusted-web-content>` and `</untrusted-web-content>` lines; a delimiter inside the page
  text is broken with a zero-width space. `selection` and `language` may be `null`.
  `background` says the tab was not in front while it was read. `agent-cancel`'s `id` is an
  integer 1 to 2^53 − 1, the id of one of the same connection's requests.

- **Asking.** Every agent command but `agent-hello`, `agent-ping` and `agent-cancel` waits for the
  user's answer in Vimma, or runs under a grant of that connection and tool. An agent connection's
  requests do not wait for each other: each is answered by `id` when its answer comes, so responses
  may come out of order. A connection with requests waiting is not closed by the 60 s idle limit.
  Limits: at most 4 agent connections (of the server's 8), at most 4 requests of one agent
  connection waiting or running at once, and at most 10 `agent-open`s of one connection a minute;
  beyond each, `busy`. Strings in agent replies are well-formed Unicode (a lone surrogate becomes
  U+FFFD), and the read's `selection` is inside the untrusted-content delimiters too.
- **Withdrawing a question.** `agent-cancel` takes back the question of one of the connection's
  own requests while it still waits: the question leaves the line, the request is answered
  `denied` with reason `cancelled`, and the result says `cancelled: true`. A request that is no
  longer waiting (answered, running, or an unknown id) and any other connection's request are
  untouched: `cancelled: false`. It never asks and is not counted in the 4 requests a
  connection may have waiting or running, so it reaches a connection whose requests all wait.
  `vimma-ctl mcp` sends it for MCP's `notifications/cancelled` ([vimma-mcp](vimma-mcp.md)
  decision 17). An older protocol 2 server answers it `unknown-command`, which leaves the
  question to time out as before.

### Profile discovery (`vimma-ctl`)

`--profile <dir>` (or `VIMMA_PROFILE`) names the profile directory directly. Otherwise, on Linux:

1. Root: `$XDG_CONFIG_HOME/vimma/vimma` (default `~/.config/vimma/vimma`), or the legacy
   `~/.vimma/vimma` if it exists (spec m0-branding, `nsXREDirProvider`).
2. `profiles.ini` there, the layout Firefox's `nsToolkitProfileService` writes:

   ```ini
   [Install4F96D1932A9F858E]
   Default=jpa751c5.default-release
   Locked=1

   [Profile0]
   Name=default-release
   IsRelative=1
   Path=jpa751c5.default-release
   Default=1

   [General]
   StartWithLastProfile=1
   Version=2
   ```

3. The profile is, in order: the `Default=` of the first `[Install…]` section (what the browser
   actually starts with); else the `[Profile…]` with `Default=1`; else the only `[Profile…]`.
   `Path` is relative to the root when `IsRelative=1`, absolute otherwise.
   Checked against a real Firefox profile directory, whose `[Install…] Default` and
   `[Profile…] Default=1` name different profiles: Firefox starts the install's, and so does the
   client.

### `vimma-ctl` usage and exit codes

```
vimma-ctl [--profile DIR] [--timeout SECS] send-keys KEYS
vimma-ctl [--profile DIR] [--timeout SECS] state [--json]
vimma-ctl [--profile DIR] [--timeout SECS] open URL
vimma-ctl [--profile DIR] [--timeout SECS] reload-theme   # prints changed or unchanged
vimma-ctl [--profile DIR] mcp                              # MCP over stdio (vimma-mcp)
```

| Exit | Meaning                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------- |
| 0    | success                                                                                                    |
| 1    | the server answered with an error (code and message printed to stderr)                                     |
| 2    | usage error                                                                                                |
| 3    | Vimma not reachable: no profile, no or stale discovery file, insecure file, no server, `busy`, `role-off`  |
| 4    | authentication failed (`unauthorized`, `unsupported-protocol`, no valid `proof`), or full control `denied` |
| 5    | protocol error: malformed response, wrong id, connection closed, timeout                                   |

The timeout (default 5 s, at most 3600 s) covers connect, handshake and the response; it is
capped so the deadline cannot overflow. While the discovery file lists `agent`, the welcome of a
`full` connection may wait up to 310 s for the user's answer, and then the command gets its own
timeout. `vimma-ctl mcp` takes no `--timeout` or `--json`: each of its calls waits for the user,
and it runs until its stdin closes (exit 0); [vimma-mcp](vimma-mcp.md) describes it.

### What the server must do

The server ([m0-control-server](m0-control-server.md), `ctl/VimmaControl.sys.mjs`) starts only while
a role's switch is on and stops when both are off; listens loopback-only on port -1; writes the
discovery file 0600 atomically and deletes it at `quit-application-granted`; makes the token with
`crypto.getRandomValues` (32 bytes, hex); enforces the limits in Security and privacy; validates
every line with `validateMessage`, compares tokens with `tokensEqual`, enforces the 1 MiB line limit
and the 5 s handshake deadline, and answers in the fixtures' formats; runs `send-keys` through the
same dispatcher path as real keydowns, `state` from the host's dispatcher and `gBrowser`, and `open`
with the triggering principal the command-line handler uses for URLs, only for schemes the validator
allows; and answers `not-implemented` for reserved commands.

## Security and privacy

- **Off unless enabled.** Pref `vimma.control.enabled` (bool, default `false`) in every build,
  dev and release. With it off there is no listening socket and no discovery file. The e2e
  harness sets it in its temporary profile's `user.js`; users turn it on in `about:config`, or
  for a while with `:control on <minutes>` (vimma-mcp decision 29). `config.toml` has no
  `[control]` table.
- **Localhost only**, loopback-only server socket, random port.
- **Token**: 256 bits, new at every start, compared in constant time, required before any
  command. A wrong token closes the connection.
- **File permissions 0600** on the discovery file, written atomically; the client refuses a
  wider mode. The profile directory itself is already 0700.
- **Scope of trust**: anyone who can read the profile can already read cookies and history, so
  the token adds no new exposure beyond that user; it keeps other local users and web content
  (DNS rebinding, `fetch` to localhost) out. Web pages cannot speak raw TCP and cannot read the
  token, and a non-JSON first line (an HTTP request) is rejected.
- `open` refuses `javascript:` and `data:` URLs, so a client cannot run script in a page's
  context through it.
- **Connection limits.** Any local user can connect before proving the token, so the server
  bounds what a connection may hold:
  - **At most 8 authenticated connections** and, apart from them, **at most 2 still in the
    handshake**. Real use is one short-lived `vimma-ctl` per command plus the e2e harness; 8 leaves
    room for scripts running in parallel. Anyone local can open waiting connections, so a new
    one evicts the oldest waiting one (answered `busy`) instead of being refused: idle
    connections cannot lock out a client that holds the token, which answers at once. A fast
    **connect flood still can**: two new connections arriving between a client's connect and its
    `auth` evict it. That is an active local denial of service by a process of some local user;
    the remedy is turning the pref off. Up to 16 refused connections linger 1 s to deliver their
    `busy`; beyond that they are closed at once.
  - **Handshake deadline 5 s** (above): no `welcome` earned within 5 s of connecting → close.
  - **Idle timeout 60 s after the handshake**: no complete request line for 60 s → the server
    closes the connection without a message. A client that wants a long-lived connection sends
    a request (e.g. `state`) at least every 60 s.
  - **At the limit**, the 9th correct `auth` is answered with one line
    `{"type":"response","id":null,"ok":false,"error":{"code":"busy","message":"…"}}` and the
    connection closes, so the client can tell "busy" from "not running". It never queues.
  - **A client that stops reading** (over 4 MiB of unsent replies) is disconnected.
  - `vimma-ctl` reports `busy` as "Vimma's control socket is busy (…); try again" with exit 3;
    a refused connection is exit 3 ("not running"); a connection dropped mid-reply (idle
    timeout, shutdown) is exit 5 "connection closed before a complete reply".

- **Where the token lives, and the default.** The token lives in `<profile>/vimma-control.json`
  (0600), and the socket is **off by default in all builds**, release included: nothing needs it
  on by default, and the e2e harness turns it on in its own profile. Changing the default is a
  one-line pref change plus a note here.
- **Agents.** With only MCP on, the token reaches only the confined, confirmed `agent` role
  (above, and [vimma-mcp](vimma-mcp.md) § Security and privacy). `vimma-ctl mcp` reads the token
  from the discovery file only, and never asks for the `full` role.

## Tests

- `packages/vimma-core/test/control.test.mjs` (Vitest): every fixture in
  `tests/contract/control/v1/` validates as its file name says (`*.valid.json` /
  `*.invalid.json`); every message type has both; table tests for each rule; `tokensEqual`.
- `tools/vimma-ctl` (`cargo test`):
  - unit: the JSON parser/printer; decoding every server-direction fixture (`challenge`, `welcome`,
    `response-*`, `discovery`) accepts the valid and rejects the invalid one; encoding `hello` and
    each request equals the valid client-direction fixture; `profiles.ini` resolution.
  - integration (`tests/cli.rs`, a `std::net::TcpListener` fake server in the test): auth success
    and failure, `send-keys`, `state`, `state --json`, `open`, a server error response, a
    malformed response, a timeout, no server (exit 3, clear message), insecure discovery file.

Fixture format: `{ "description", "kind", "command"?, "message" }` where `kind` is `hello`,
`challenge`, `auth`, `welcome`, `request`, `response` or `discovery`, and `command` (responses only)
says which command's result shape applies.

Protocol 2: `packages/vimma-core/test/control-v2.test.mjs` runs every fixture in
`tests/contract/control/v2/` (one valid and one invalid per new message, `agent-cancel`
included) and table tests for the role, the agent commands' args and results and `denied`'s
reason; the Rust client's tests decode the v2 server-direction fixtures, and `src/mcp.rs`
checks that the agent commands `vimma-ctl mcp` sends and decodes match the v2 fixtures. The
property tests in `tools/vimma-ctl/tests/protocol_props.rs` fuzz the JSON parser and every
decoder ([m7-fuzzing](m7-fuzzing.md)). The server's side is in
`tests/browser/browser_vimma_control.js` and `browser_vimma_mcp_agent.js`.

All of it was written first and seen to fail: the client's first run had every function a
`todo!()` stub (unit "1 passed; 43 failed", integration "1 passed; 16 failed"), and the
hardening (the `--timeout` cap, `busy`, the 64 KiB discovery-file cap) failed to compile before
it was added.

## Docs and changelog

- `docs/guide.md`, "Scripting with vimma-ctl": the commands, the pref, exit codes; "Agents
  (MCP)" for protocol 2's agent side.
- `docs/security.md` §1 holds the socket's rules to their tests; ADR-007, ADR-011 and
  ADR-019 record the choices.
- Each protocol change is a `CHANGELOG.md` line in the release that ships it.

## Delivery

1. The protocol, its v1 fixtures, the validator and `vimma-ctl` (this spec), with CI's Rust
   steps (fmt, clippy `-D warnings` with `pedantic`, tests) in the existing `ci.yml` job (ADR-011:
   one job on purpose, minutes are billed per job) and a crate licence check
   (`npm run license-check:crates`).
2. The browser-side server: [m0-control-server](m0-control-server.md).
3. Protocol 2 and `vimma-ctl mcp`: [vimma-mcp](vimma-mcp.md) sub-PRs 2a, 2b and 3.

Out of scope: macOS and Windows profile discovery (the macOS spec takes it up),
`list-tabs`/`screenshot`/`reload-config` beyond reserving them, AUR packaging.

## Open questions

None.
