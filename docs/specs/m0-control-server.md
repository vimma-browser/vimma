# Spec: m0-control-server

Status: implemented · Milestone: M0 · Area: `src/browser/base/content/vimma/ctl/`
Prerequisites: ADR-007 (control socket), ADR-011 (vimma-ctl), spec
[m0-control-protocol-and-vimma-ctl](m0-control-protocol-and-vimma-ctl.md) (the protocol, which
is authoritative; this spec only adds what the browser side decides).

## User story

As a user or the e2e harness, with `vimma.control.enabled` on, `vimma-ctl state`,
`vimma-ctl send-keys "ctrl+b ?"` and `vimma-ctl open https://example.com` work against the
running browser, and with it off nothing listens and no token file exists.

## Scope

- `ctl/VimmaControl.sys.mjs`: protocol v1 server (protocol 2 and its roles since
  [vimma-mcp](vimma-mcp.md)). One per app: every window's `vimma.js` calls
  `VimmaControl.init(window)`, which acts once. The pref `vimma.control.enabled` (default `false`,
  branding prefs file) starts and stops it live; starts and stops run one after another.
- `nsIServerSocket.init(-1, /* loopbackOnly */ true, 16)`: 127.0.0.1, an OS-chosen port.
- Discovery file `<profile>/vimma-control.json` `{protocol, port, token, pid}`, 0600 from creation,
  renamed into place. Whatever is at that path is removed when the first window starts (pref
  on or off), before a start, and when the pref goes off, at `quit-application-granted` and
  (as a backstop) in an `AsyncShutdown.profileBeforeChange` blocker.
- Line framing, 1 MiB limit, 5 s hello deadline, 60 s idle timeout, 8 authenticated connections
  then `busy`, at most 2 waiting for a hello (a new one evicts the oldest that has not spoken, else the oldest), constant-time token
  check (`tokensEqual`), a challenge proving the token before the client sends it, every message
  checked with `validateMessage`.
- Commands `send-keys`, `state`, `open`, `reload-theme` (since m5-omarchy-theme:
  `ThemeHost.reload()`); `list-tabs`, `screenshot`, `reload-config` answer `not-implemented`.
- Host seam: none of our own. `state` reads `VimmaHost.status(win)` (`{ mode, pending }`, added
  for the status bar by m2-statusbar-whichkey), so the socket and the status bar cannot disagree.
  An earlier `controlState(win)` doing the same was dropped when that landed.

## Settled

- **Key injection: a `TextInputProcessor`, not the dispatcher.** Each chord becomes a real key
  press: modifier keydowns, the key's keydown/keyup, modifier keyups, through
  `nsITextInputProcessor.beginInputTransaction(win)` on the most recently focused browser window
  (`BrowserWindowTracker.getTopWindow`). The events are trusted and go through the widget, so
  the host's capture-phase keydown listener (and so the dispatcher and mode handling), Firefox's
  `<key>` shortcuts (`ctrl+t`, `ctrl+q`) and the focused page all see what a keyboard would have
  produced. Calling the dispatcher directly would skip Firefox's shortcuts and the page, so e2e
  would test something users never do. Cost: keys go where focus is; for page-bound keys that is
  the page only while the window has focus, as with a real keyboard. `?` is sent without shift
  (vimma-core's canonical chord), which the host treats the same.
- **`state.pending`** is `VimmaHost.status(win).pending.join(" ")`, what the status bar shows:
  `"prefix"` after `ctrl+b`, `null` when empty. `mode` is the host's `_mode`: `help` with the
  overlay open, else the focused page's mode (`normal` on a page with Vimma's actor, `insert` in a
  text field, a page without the actor, or chrome; m1-actor-insert-scroll). Each tab also has
  `index` (strip order among visible tabs) and `pinned`; clients ignore fields they do not
  know. `workspace` is the active workspace's name and `panes` the window's pane tree, `null`
  with one pane (shape in the protocol spec; m3-workspaces sub-spec 7).
- **`open`**: the URL is re-parsed with `Services.io.newURI` and its scheme checked again
  (http, https, file, about). Loaded with the **system principal**, as `BrowserContentHandler`
  does for `vimma <url>`: the token holder is the user, and with `javascript:`/`data:` refused
  nothing runs in a page's context. Not through `browserDOMWindow.openURI(OPEN_EXTERNAL)` like
  the command line: that turns an external `about:blank` into the new-tab page with the URL bar
  focused, and lets the external-link prefs choose another window, while `where` here is
  explicit. `tab`: `gBrowser.addTab(url, { triggeringPrincipal, inBackground: false })`;
  `current`: `selectedBrowser.loadURI`. Checked: the opened page has its own content principal.
- **Discovery file 0600 with no window**: `IOUtils.createUniqueFile(profile,
"vimma-control.json.tmp", 0o600)`, then `IOUtils.writeUTF8` (an overwrite keeps the mode,
  `IOUtils.cpp` WriteSync opens with `PR_TRUNCATE`), then `IOUtils.move` over the real name.
  `writeJSON({ tmpPath })` would create the temporary file 0644 and leave a window before a
  `setPermissions`.
- **Loopback only, verified**: `nsServerSocket::Init(…, loopbackOnly)` →
  `InitSpecialConnection` → `PR_SetNetAddr(PR_IpAddrLoopback, PR_AF_INET, …)` (127.0.0.1, not
  `::1`, not 127/8). The test connects to 127.0.0.2 (Linux) and gets `NS_ERROR_CONNECTION_REFUSED`.
- **Starts after the first window's delayed startup**: the server (and so the file) waits for
  `browser-delayed-startup-finished` of the window that called `init`. Found by the e2e harness:
  writing the file during the first window's load let `state` answer `failed: no browser window`
  in ~70 % of runs. `topWindow()` also falls back to `Services.wm.getMostRecentWindow`.
- **Errors that end a connection linger** (`unauthorized`, `unsupported-protocol`, `bad-request`
  in the handshake or for an oversized line, `busy`): the server writes the error, then reads and
  drops input until the client closes or 1 s passes, then closes. Closing at once lost the
  answer in ~10 % of runs (a socket closed with unread input is reset; our own JS test client
  also saw the close before the data). `busy` connections linger outside the 8-connection count.
- **The line limit counts bytes** (1 MiB = `MAX_LINE_LENGTH`, plus one for a trailing `\r`), not
  UTF-16 units: a byte cap bounds memory before decoding and is never looser. A line over the
  limit is answered as soon as the limit is passed, without waiting for its newline.
- **Quitting while a command runs** (`send-keys ctrl+q`): the in-flight request is answered,
  then the connection closes; the file is removed. Verified with the real build (exit 0, file
  gone, `vimma-ctl` exit 0).
- **A key that opens a dialog** (since
  [#1306](https://github.com/vimma-browser/vimma/issues/1306)): Firefox runs "Leave page?" and a
  window's prompts in a nested event loop, so the keydown that opens one returns only once the
  dialog is answered, and while it is being dispatched no other TextInputProcessor can begin a
  transaction on the window (`TextInputProcessor::BeginInputTransactionInternal`). `send-keys`
  therefore presses its keys in a task of its own and answers with `dialog: true` when a
  `dialogopen` reaches the window while they are being pressed, and every `send-keys` presses
  through one processor with one callback, which can begin again mid-dispatch, so the next
  `send-keys` reaches the dialog. Each `send-keys` starts with no modifier held in that
  processor (`shareModifierStateOf(null)`), and releases a chord's modifiers even when a key
  throws, so the waiting key's ctrl never turns the answer `n` into `ctrl+n`. Known gap: a dialog
  in a window of its own, or a nested event loop with no `dialogopen`, still holds that
  `send-keys`' answer and its connection's later requests until it ends; a `send-keys` on
  another connection can still answer it.
- **`SIGTERM` does not run our shutdown** (measured, 157.0.1 headless: the process dies by the
  signal in ~20 ms, exit 143). The discovery file then stays; clients report it as stale ("not
  running") and the next start overwrites it. Harnesses should quit with `send-keys ctrl+q`
  (`browser.warnOnQuitShortcut=false`) and keep signals as the fallback.
- **Test-only prefs** `vimma.control.helloTimeoutMs` and `vimma.control.idleTimeoutMs` (read per
  connection, unset in builds).
- **vimma-ctl in mochitests**: the test resolves `tools/vimma-ctl/target/{release,debug}/vimma-ctl`
  through its symlink into the checkout (or `VIMMA_CTL`) and runs it with `Subprocess.sys.mjs`.
  Absent → skip with a message; `e2e.yml` builds it (`cargo build --locked`, the harness's step)
  and sets `VIMMA_REQUIRE_CTL=1` so CI cannot silently skip. The nightly full-build run skips it.

## Tests (written first)

`tests/browser/browser_vimma_control.js`:

- Pref off: no listener, no file. On: file valid per `validateMessage(kind: discovery)`, mode
  0600, port matches, pid is the parent, no `.tmp` left, handshake works, 127.0.0.2 refused. Off:
  file gone, old port refused. On again: a new token.
- Handshake: wrong token → exact `unauthorized` response, then close; an HTTP request →
  `bad-request`, close; protocol 3 → `unsupported-protocol`, close; right token → valid
  `welcome` (app, version). After it: not-JSON → `bad-request`, unknown command, reserved →
  `not-implemented`, unknown args → `invalid-args`, connection still usable.
- `send-keys ctrl+b` → `state.pending` `"prefix"`; `?` → overlay opens, host saw real keydowns,
  `state.mode` `help`; `esc` closes it, back to `normal`; a bad chord → `invalid-args` and nothing
  sent. `state` fields: tabs, ids (`browserId`), url, index, pinned, the workspace's name; `panes`
  null with one pane, after a split the tree (`test_state_panes`). (Since changed: an unloaded
  tab's id is its workspace uuid until it loads, not its browser id `0`; #1332.)
- `send-keys "j shift+k"` with the page focused, in normal mode: Vimma takes `j` (as with a real
  `j`), the page records `Shift`, `K`.
- `open https://example.com/` → new selected tab, result id, content principal; `where: current`
  reuses it; `about:blank` → a new selected tab at `about:blank`; `javascript:`, `data:`,
  `chrome:` → `invalid-args`, nothing opened.
- Limits: 8 authenticated connections, the 9th hello gets `busy` (id null, no doubled "busy:") and a
  close, a freed slot works; 20 connections that never say hello leave 2 waiting (the evicted told
  `busy`) and a client with the token still gets in, also when two silent connections arrive
  after its hello but before the server reads it (#1344); an oversized line → `bad-request` and a close;
  idle (500 ms pref) → closed without a message; no hello (300 ms pref) → `bad-request` and a close.
- `vimma-ctl --profile <test profile> state --json` exits 0 with the live state; 5 more runs
  succeed during a flood of 30 idle connections; against a squatting socket (a stale discovery
  file with a token it does not know) it exits 4 and the squatter receives no command.
- The handshake: every challenge's proof is checked by the test client with WebCrypto; a hello
  without a nonce, a hello carrying the token, an auth before the hello and a request before
  the auth are `bad-request` and close; a hello that never gets its auth is closed at the
  deadline. 40 connections in a burst: at most 16 refused ones linger.
- The server's own scheme check, called directly (`_commands.open`): `javascript:`, `data:`,
  `chrome:` → `invalid-args`.
- Start-up cleanup (`_restartForTests`): a stale file goes with the pref off; a directory at the
  path is left alone and the server does not start; a symlink to a directory is removed, its
  target untouched.
- Shutdown with a first window that never finished its delayed startup completes (no hang), and
  no file or listener is left.

Every response is checked with `validateMessage(kind: response, command)`.

## Implementation log (2026-10-09)

- TDD red: the new test crashed the browser at import (`CheckForBrokenChromeURL`: no
  `ctl/VimmaControl.sys.mjs`), 0 passed. Green: 143 passed, then 152 with the `about:blank` case.
- Mutation: comparing only `typeof m.token` (no `tokensEqual`) → "a wrong token is unauthorized"
  failed (got `welcome`) and the task timed out; reverted.
- Flakiness: `--repeat=19` found lost error replies (16 failures in 20 runs) and an idle pref that
  leaked into the connection-limit check; fixed (lingering close, EOF detected by a 0-byte read
  instead of `available() == 0`, which is also 0 before the transport attaches; output waits
  dispatched to the main thread; idle pref scoped). Then 20/20 green, and 10/10 on two busy CPUs.
- Real build, headless, temporary profile, 21 launches: `state` the moment the file appears
  succeeded every time (mode 0600); `open about:blank` then `send-keys "ctrl+b ?"` gave two tabs,
  the new one selected at `about:blank`, mode `help`.
- Suites: full build `tests/browser/` 602 passed, 0 failed; artifact build 585 passed, 0 failed.
- Merged main (#28 tab keys, #32 normal mode and actors, #35 e2e harness). Red: 4 failures, the
  page now starts in `normal` and takes `j`; the tests now expect `normal` and the page to see
  only `Shift`, `K`. Green: full build 903 passed, artifact build 886 passed, 0 failed. The e2e
  workflow's existing `vimma-ctl` build (debug) serves the mochitest too.
- Merged main again (#34 status bar): `state` now reads `VimmaHost.status(win)` instead of our
  own `controlState`. Full build 981 passed, artifact build 964 passed, 0 failed.

## Hardening

Two weaknesses were fixed before the server shipped:

1. **Waiting connections could lock out clients.** Eight shared slots, each held ~5.7 s by a
   connection that never says hello: a reconnect loop made `vimma-ctl state` fail `busy` 10/10.
   Now 8 authenticated slots and, apart, 2 waiting ones; a new connection evicts the oldest
   waiting one (`busy`). vimma-ctl says hello right after connecting, so it wins the race.
   Amended (#1344): the server takes new connections before it reads the ones it has, so on a
   slow machine vimma-ctl's hello could wait unread while two silent connections arrived, and
   it was the one evicted (CI, `vimma-ctl state during a flood`). Now a new connection evicts
   the oldest waiting one that has sent nothing (read, or still in its socket), else the oldest.
   Red: the mochitest holding the main thread so vimma-ctl's connect and hello come before two
   silent connects failed 2/2 with `busy: evicted`; green 20/20 on two busy CPUs.
2. **A stale discovery file let a squatter impersonate the server.** With the pref off nothing
   removed a crashed run's file, so another local user could bind its port and receive
   `send-keys`. Now: (a) the first window's `init` removes whatever is at the path (pref on or
   off), stop removes the file before closing the socket, a real directory there is left alone
   and blocks the start, a symlink is removed and not followed; (b) protocol v1 is amended: the
   `hello` carries a random `nonce`, the `welcome` a `proof` = HMAC-SHA256(token, nonce), and
   vimma-ctl sends nothing else until the proof checks out (constant time; forgeable, as the
   token went in the hello: superseded, see the handshake notes below); (c) vimma-ctl
   reports a stale file when its `pid` is not alive (`/proc/<pid>`, Linux). HMAC-SHA256 is
   ~100 lines of std-only Rust (`tools/vimma-ctl/src/hmac.rs`, FIPS 180-4 and RFC 4231 vectors)
   rather than a crate (ADR-011: no dependencies); the server uses WebCrypto.

Further fixes: the guide's Security section says the token is full control of the browser, that
`open` uses the system principal (`file:`, privileged `about:` pages), that stale files go at
every start, and lists the denial-of-service limits. `shutdown()` releases the wait for the first
window, so the `profileBeforeChange` blocker cannot hang when that window closed before its
delayed startup. The server's own scheme check has a direct test. "busy: busy:" is gone
(messages no longer start with the code), more than 4 MiB of unsent output closes a client that
stopped reading (not tested: the kernel's socket buffers would have to fill first), and `ctrl+q`
with the help overlay open is swallowed like any key there, as when typing: documented (send
`esc` first) rather than special-cased.

Red/green: Vitest 4 failed (nonce, proof), then 90 passed; cargo did not compile (`hello` takes
one argument, no `proof`), then 53 unit + 24 integration passed; the mochitest 24 failed
(no proof, no `_restartForTests`, `busy: busy:`, flood timed out), then 207 passed on the
artifact lane. Mutation: with the server's scheme check removed, `javascript:` and `data:` passed
through `_commands.open` (2 failures; `chrome:` crashed the browser loading it); reverted.

## Security notes: the handshake

**The proof was forgeable.** The client sent the token in the `hello`, next to the nonce, before
checking anything, so a squatter received the key and computed HMAC(token, nonce) itself; a test
squatter received `send-keys hunter2<cr>`. The handshake is now hello {nonce, no
token} → challenge {proof = HMAC-SHA256(token, "vimma-server\0" + nonce)} → auth {token} →
welcome, still an amended v1. The client checks the proof in constant time (`black_box` around
the fold) and sends nothing more on a mismatch. One 5 s deadline and the waiting-slot rules
cover the whole handshake. Refused connections lingering for their answer are capped at 16;
beyond that they close at once. SHA-256/HMAC gained empty-key, 55/56/63/64/65-byte message and
64/65-byte key vectors (from Python's `hmac`; these passed at once, as the implementation was
already right). Docs now state what is guaranteed (no token or command to a squatter) and what
is not (a squatter can make the client wait; a fast connect flood can evict a client mid-handshake).

Red/green: Vitest 10 failed (fixtures and table tests for hello/challenge/auth), then 96
passed; cargo did not compile (`hello` takes one argument, `expected_proof` gone), then 55 unit
and 25 integration passed, among them that squatter ported to `tests/cli.rs` (it answers
with an HMAC keyed by any token it saw: it receives only the hello) and a squatter that never
answers (clean timeout, exit 5); the mochitest 33 failed, then 219 passed.

## For the e2e harness (PR #35)

1. File within 30 s: yes, right after the first window's delayed startup.
2. `state`: the host's mode. Measured after the m1-actor-insert-scroll merge on the real build
   (headless, fresh profile, `about:blank` start page): **`insert`** at startup (focus is in
   chrome), so the scenario's `insert` holds; `normal` once a page has focus (the
   mochitest's case); `help` with the overlay. Tabs carry `url` and `selected`.
3. Fresh profile with `browser.startup.page=0`: one `about:blank` tab; `open about:blank` adds
   a second, selected, at `about:blank`.
4. `send-keys "ctrl+b ?"`: real key presses (TextInputProcessor).
5. Differs: **`SIGTERM` leaves the discovery file** (see Settled). Quit with
   `send-keys ctrl+q` and `browser.warnOnQuitShortcut=false` to get a clean exit (0) and the file
   removed; teardown can then still signal and delete the temporary profile.

## Out of scope

`list-tabs`, `screenshot`, `reload-config`; a `[control]` table in `config.toml`; macOS/Windows
specifics; enabling the harness scenario (PR #35's follow-up once both merge).
