/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/m0-control-server.md (protocol: docs/specs/m0-control-protocol-and-vimma-ctl.md)

/* global focusContent, recordPageKeys, pageKeys, waitForPageKey -- from head.js */

"use strict";

const { validateMessage, MAX_LINE_LENGTH, TOKYO_NIGHT, BUILTIN_THEMES } =
  ChromeUtils.importESModule("chrome://browser/content/vimma/core/index.mjs");
const { VimmaControl } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
);
const { VimmaHost } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/VimmaHost.sys.mjs",
);
const { WindowWorkspaces } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/workspaces/WindowWorkspaces.sys.mjs",
);
const { PaneViews } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/split/PaneView.mjs",
);
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");

const ENABLED = "vimma.control.enabled";
const HELLO_TIMEOUT = "vimma.control.helloTimeoutMs";
const IDLE_TIMEOUT = "vimma.control.idleTimeoutMs";
const DISCOVERY = PathUtils.join(PathUtils.profileDir, "vimma-control.json");
const OVERLAY_ID = "vimma-help";

registerCleanupFunction(async () => {
  document.getElementById(OVERLAY_ID)?.close();
  Services.prefs.clearUserPref(ENABLED);
  await VimmaControl.settled();
});

/**
 * A raw protocol client over nsISocketTransport: JSON lines in, JSON lines out.
 */
class Client {
  /** @param {number} port @param {string} [host] */
  constructor(port, host = "127.0.0.1") {
    const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(
      Ci.nsISocketTransportService,
    );
    this.transport = sts.createTransport([], host, port, null, null);
    this.output = this.transport.openOutputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
    this.input = this.transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
    this.binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    this.binary.setInputStream(this.input);
    this.buffer = "";
    /** @type {string[]} complete lines not yet taken */
    this.lines = [];
    /** @type {Array<() => void>} */
    this.waiters = [];
    /** Result code once the connection ended (0 for a clean close), else null. */
    this.closedWith = null;
    this.closed = new Promise((resolve) => (this.resolveClosed = resolve));
    this.wait();
  }

  wait() {
    this.input.asyncWait(this, 0, 0, Services.tm.mainThread);
  }

  onInputStreamReady() {
    try {
      // available() is 0 at EOF but also before the socket is connected: read to tell.
      const n = Math.max(this.input.available(), 1);
      const chunk = new Uint8Array(n);
      const read = this.binary.readArrayBuffer(n, chunk.buffer);
      if (read === 0) {
        this.end(0);
        return;
      }
      this.buffer += String.fromCharCode(...chunk.subarray(0, read));
      let nl;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const bytes = Uint8Array.from(this.buffer.slice(0, nl), (c) => c.charCodeAt(0));
        this.lines.push(new TextDecoder().decode(bytes));
        this.buffer = this.buffer.slice(nl + 1);
      }
      this.wake();
      this.wait();
    } catch (e) {
      if (e.result === Cr.NS_BASE_STREAM_WOULD_BLOCK) this.wait();
      else this.end(e.result === Cr.NS_BASE_STREAM_CLOSED ? 0 : e.result);
    }
  }

  /** @param {number} code */
  end(code) {
    if (this.closedWith !== null) return;
    this.closedWith = code;
    this.resolveClosed(code);
    this.wake();
  }

  wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** The next line as an object, or null once the server closed without one. */
  async read() {
    while (!this.lines.length && this.closedWith === null) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    const line = this.lines.shift();
    return line === undefined ? null : JSON.parse(line);
  }

  /** @param {string} text written as UTF-8, all of it (waits while the socket is full) */
  async writeRaw(text) {
    let data = "";
    // Encode in chunks: String.fromCharCode(...bigArray) overflows the stack.
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 8192) {
      data += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    while (data.length) {
      try {
        const n = this.output.write(data, data.length);
        data = data.slice(n);
      } catch (e) {
        if (e.result !== Cr.NS_BASE_STREAM_WOULD_BLOCK) throw e;
      }
      if (data.length) {
        await new Promise((resolve) =>
          this.output.asyncWait({ onOutputStreamReady: resolve }, 0, 0, Services.tm.mainThread),
        );
      }
    }
  }

  /** @param {object} message */
  send(message) {
    return this.writeRaw(JSON.stringify(message) + "\n");
  }

  /**
   * The handshake: hello {nonce} (no token) → challenge, whose proof is checked here with
   * WebCrypto, independently of the server's code → auth {token} → the server's last reply.
   * Returns early with any reply that is not a challenge.
   * @param {string} token
   * @param {{ checkProof?: boolean }} [options] false for a client holding a wrong token
   */
  async hello(token, { checkProof = true } = {}) {
    const nonce = randomHex();
    await this.send({ type: "hello", protocol: 1, nonce });
    const challenge = await this.read();
    if (challenge?.type !== "challenge") return challenge;
    if (checkProof) {
      Assert.equal(
        challenge.proof,
        await hmacHex(token, `vimma-server\0${nonce}`),
        "the challenge proves the token",
      );
    }
    await this.send({ type: "auth", token });
    return this.read();
  }

  async request(id, command, args = {}) {
    await this.send({ type: "request", id, command, args });
    const response = await this.read();
    Assert.ok(response, `a response to ${command} #${id}`);
    const v = validateMessage(response, { kind: "response", command });
    Assert.ok(v.valid, `response to ${command} follows the protocol: ${v.errors.join("; ")}`);
    Assert.equal(response.id, id, "the response carries the request's id");
    return response;
  }

  close() {
    this.transport.close(Cr.NS_OK);
  }
}

function randomHex() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** HMAC-SHA256(key, message) over their UTF-8 bytes, as lowercase hex. */
async function hmacHex(key, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Runs vimma-ctl with `args` against this profile: { exitCode, out }. */
async function runVimmaCtl(bin, args) {
  const proc = await Subprocess.call({
    command: bin,
    arguments: ["--profile", PathUtils.profileDir, ...args],
    stderr: "stdout",
  });
  let out = "";
  let chunk;
  while ((chunk = await proc.stdout.readString())) out += chunk;
  const { exitCode } = await proc.wait();
  return { exitCode, out };
}

async function readDiscovery() {
  return IOUtils.readJSON(DISCOVERY);
}

async function enable() {
  Services.prefs.setBoolPref(ENABLED, true);
  await VimmaControl.settled();
  Assert.ok(await IOUtils.exists(DISCOVERY), "the discovery file exists");
  return readDiscovery();
}

async function disable() {
  Services.prefs.setBoolPref(ENABLED, false);
  await VimmaControl.settled();
}

/** Connects and completes the handshake. */
async function session() {
  const { port, token } = await readDiscovery();
  const client = new Client(port);
  const welcome = await client.hello(token);
  Assert.equal(welcome?.type, "welcome", "handshake succeeds");
  return client;
}

function helpShown() {
  const o = document.getElementById(OVERLAY_ID);
  return !!o && o.open && BrowserTestUtils.isVisible(o);
}

add_task(async function test_pref_starts_and_stops_the_server() {
  Assert.ok(!Services.prefs.getBoolPref(ENABLED), "off by default (branding prefs)");
  Assert.equal(VimmaControl.port, null, "no listener while the pref is off");
  Assert.ok(!(await IOUtils.exists(DISCOVERY)), "no discovery file while the pref is off");

  const discovery = await enable();
  const v = validateMessage(discovery, { kind: "discovery" });
  Assert.ok(v.valid, `discovery file is valid v1: ${v.errors.join("; ")}`);
  Assert.equal(discovery.port, VimmaControl.port, "the file names the listening port");
  Assert.equal(discovery.pid, Services.appinfo.processID, "pid is the parent process");
  Assert.equal((await IOUtils.stat(DISCOVERY)).permissions, 0o600, "mode 0600");
  Assert.ok(!(await IOUtils.exists(DISCOVERY + ".tmp")), "no temporary file left behind");

  const client = await session();
  client.close();

  if (AppConstants.platform === "linux") {
    // Bound to 127.0.0.1 itself, not to every address: another loopback address is refused.
    const other = new Client(discovery.port, "127.0.0.2");
    Assert.equal(await other.closed, Cr.NS_ERROR_CONNECTION_REFUSED, "127.0.0.2 is refused");
  }

  // A second start makes a new token (and port): an old token is worthless.
  await disable();
  Assert.equal(VimmaControl.port, null, "listener closed");
  Assert.ok(!(await IOUtils.exists(DISCOVERY)), "pref off removes the discovery file");
  const stale = new Client(discovery.port);
  Assert.equal(await stale.closed, Cr.NS_ERROR_CONNECTION_REFUSED, "the old port is closed");

  const again = await enable();
  Assert.notEqual(again.token, discovery.token, "a new token at every start");
  await disable();
});

add_task(async function test_handshake() {
  const { port, token } = await enable();

  const wrong = new Client(port);
  const bad = await wrong.hello(
    token.replace(/^./, (c) => (c === "0" ? "1" : "0")),
    { checkProof: false },
  );
  Assert.deepEqual(
    bad,
    {
      type: "response",
      id: null,
      ok: false,
      error: { code: "unauthorized", message: "bad token" },
    },
    "a wrong token is unauthorized",
  );
  Assert.equal(await wrong.closed, 0, "and the server closes the connection");

  const http = new Client(port);
  await http.writeRaw("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
  Assert.equal((await http.read())?.error?.code, "bad-request", "an HTTP request is rejected");
  Assert.equal(await http.closed, 0, "and closed");

  const noNonce = new Client(port);
  await noNonce.send({ type: "hello", protocol: 1 });
  Assert.equal((await noNonce.read())?.error?.code, "bad-request", "a hello needs a nonce");
  Assert.equal(await noNonce.closed, 0, "and closed");

  const tokenInHello = new Client(port);
  await tokenInHello.send({ type: "hello", protocol: 1, nonce: randomHex(), token });
  Assert.equal((await tokenInHello.read())?.error?.code, "bad-request", "no token in a hello");
  Assert.equal(await tokenInHello.closed, 0, "and closed");

  const authFirst = new Client(port);
  await authFirst.send({ type: "auth", token });
  Assert.equal((await authFirst.read())?.error?.code, "bad-request", "auth before hello");
  Assert.equal(await authFirst.closed, 0, "and closed");

  const skipAuth = new Client(port);
  await skipAuth.send({ type: "hello", protocol: 1, nonce: randomHex() });
  Assert.equal((await skipAuth.read())?.type, "challenge", "a hello is challenged");
  await skipAuth.send({ type: "request", id: 1, command: "state", args: {} });
  Assert.equal((await skipAuth.read())?.error?.code, "bad-request", "no request before auth");
  Assert.equal(await skipAuth.closed, 0, "and closed");

  const v2 = new Client(port);
  await v2.send({ type: "hello", protocol: 3, role: "full", nonce: randomHex() });
  Assert.equal((await v2.read())?.error?.code, "unsupported-protocol", "protocol 3 is refused");
  Assert.equal(await v2.closed, 0, "and closed");

  const right = new Client(port);
  const welcome = await right.hello(token);
  const v = validateMessage(welcome, { kind: "welcome" });
  Assert.ok(v.valid, `welcome is valid: ${v.errors.join("; ")}`);
  Assert.equal(welcome.app, "Vimma", "app name");
  Assert.equal(welcome.version, AppConstants.MOZ_APP_VERSION_DISPLAY, "Vimma's version");

  // After the handshake, bad lines get errors and the connection stays.
  await right.writeRaw("not json\n");
  Assert.equal((await right.read()).error.code, "bad-request", "not JSON");
  await right.send({ type: "request", id: 3, command: "frobnicate", args: {} });
  Assert.equal((await right.read()).error.code, "unknown-command", "an unknown command");
  // Regression (fuzzing): naming a command that is not a string threw (String() of an object
  // whose toString is 0), and every later request waited behind the rejected one.
  await right.writeRaw('{"type":"request","id":7,"command":{"toString":0},"args":{}}\n');
  Assert.equal((await right.read()).error.code, "unknown-command", "a command not a string");
  const reserved = await right.request(4, "screenshot");
  Assert.equal(reserved.error.code, "not-implemented", "a reserved command");
  const typo = await right.request(5, "state", { verbose: true });
  Assert.equal(typo.error.code, "invalid-args", "unknown args are invalid-args");
  const state = await right.request(6, "state");
  Assert.ok(state.ok, "the connection is still usable");
  right.close();
  await disable();
});

add_task(async function test_send_keys_and_state() {
  await enable();
  const client = await session();

  let { result } = await client.request(1, "state");
  Assert.equal(result.mode, "normal", "the page's mode, normal (m1-actor-insert-scroll)");
  Assert.equal(result.pending, null, "nothing pending");
  Assert.equal(
    result.workspace,
    WindowWorkspaces.get(window).status().name,
    "the active workspace's name (m3-workspaces 7)",
  );
  Assert.equal(typeof result.workspace, "string", "a name, not null, now that workspaces exist");
  Assert.equal(result.panes, null, "one pane: no tree");
  Assert.equal(result.tabs.length, gBrowser.visibleTabs.length, "every visible tab");
  const selected = result.tabs.filter((t) => t.selected);
  Assert.equal(selected.length, 1, "one selected tab");
  Assert.equal(selected[0].id, String(gBrowser.selectedBrowser.browserId), "id is the browserId");
  Assert.equal(selected[0].url, gBrowser.currentURI.spec, "url");
  Assert.equal(
    selected[0].index,
    gBrowser.visibleTabs.indexOf(gBrowser.selectedTab),
    "index in strip order",
  );
  Assert.equal(selected[0].pinned, false, "pinned");

  const prefixOnly = await client.request(2, "send-keys", { keys: "ctrl+b" });
  Assert.deepEqual(prefixOnly.result, { sent: 1 }, "one chord sent");
  ({ result } = await client.request(3, "state"));
  Assert.equal(result.pending, "prefix", "the pending prefix, as the status bar shows it");

  const keys = await client.request(4, "send-keys", { keys: "?" });
  Assert.deepEqual(keys.result, { sent: 1 }, "sent");
  await TestUtils.waitForCondition(helpShown, "send-keys ctrl+b ? opens the help overlay");
  Assert.deepEqual(VimmaHost._lastChords.slice(-2), ["ctrl+b", "?"], "seen as real keydowns");
  ({ result } = await client.request(5, "state"));
  Assert.equal(result.mode, "help", "state reports help mode");
  Assert.equal(result.pending, null, "the sequence completed");

  await client.request(6, "send-keys", { keys: "esc" });
  await TestUtils.waitForCondition(() => !helpShown(), "send-keys esc closes it");
  ({ result } = await client.request(7, "state"));
  Assert.equal(result.mode, "normal", "back to normal");

  const invalid = await client.request(8, "send-keys", { keys: "ctrl+b nosuchkey" });
  Assert.equal(invalid.error.code, "invalid-args", "an unparseable chord");
  Assert.equal(VimmaHost._lastChords.at(-1), "esc", "and none of its chords were sent");

  client.close();
  await disable();
});

// m3-workspaces 7: the e2e restart scenario asserts the split layout through `state.panes`.
add_task(async function test_state_panes() {
  await enable();
  const client = await session();
  const view = PaneViews.get(window);
  const left = gBrowser.selectedTab;
  Assert.ok(view.split("vertical").ok, "split right");
  await TestUtils.waitForCondition(() => view.panes, "the split is laid out");
  const right = gBrowser.selectedTab;
  Assert.notEqual(right, left, "the new pane shows a new tab");

  const { result } = await client.request(1, "state");
  const v = validateMessage(
    { type: "response", id: 1, ok: true, result },
    { kind: "response", command: "state" },
  );
  Assert.ok(v.valid, `the state is valid: ${v.errors.join("; ")}`);
  const id = (tab) => String(tab.linkedBrowser.browserId);
  const index = (tab) => result.tabs.findIndex((t) => t.id === id(tab));
  Assert.ok(index(left) >= 0 && index(right) >= 0, "both panes' tabs are in tabs");
  Assert.deepEqual(
    result.panes,
    {
      focus: id(right),
      zoomed: false,
      hidden: false,
      root: {
        axis: "x",
        ratios: [0.5, 0.5],
        children: [
          { tab: id(left), index: index(left) },
          { tab: id(right), index: index(right) },
        ],
      },
    },
    "the pane tree in state's tab ids, with each leaf's place in tabs",
  );

  client.close();
  await disable();
  Assert.ok(view.close().ok, "close the right pane");
  gBrowser.removeTab(right);
  await TestUtils.waitForCondition(() => !view.panes, "one pane again");
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
});

// docs/specs/multiple-splits.md, "Control protocol": every split of the workspace in `splits`,
// read-only; `panes` keeps its meaning (the shown split, else the one shown last, hidden).
add_task(async function test_state_splits() {
  await enable();
  const client = await session();
  const view = PaneViews.get(window);
  const state = async (id) => {
    const { result } = await client.request(id, "state");
    const v = validateMessage(
      { type: "response", id, ok: true, result },
      { kind: "response", command: "state" },
    );
    Assert.ok(v.valid, `the state is valid: ${v.errors.join("; ")}`);
    return result;
  };
  Assert.ok(!("splits" in (await state(1))), "no splits field while the feature is off");

  await SpecialPowers.pushPrefEnv({ set: [["vimma.feature.multiple_splits", true]] });
  const tabs = [];
  for (const q of ["s1", "s2", "s3", "s4", "s5"]) {
    const t = BrowserTestUtils.addTab(gBrowser, `https://example.com/?${q}`);
    await BrowserTestUtils.browserLoaded(t.linkedBrowser);
    tabs.push(t);
  }
  const [a, b, c, d, lone] = tabs;
  Assert.equal(Object.keys(await state(2)).includes("splits"), true, "splits with the feature");
  Assert.deepEqual((await state(3)).splits, [], "none yet");

  Assert.ok(view.showTabs([a, b], a).ok, "S1: a | b");
  gBrowser.selectedTab = lone;
  Assert.ok(view.showTabs([c, d], d).ok, "S2: c | d, made on a lone tab");
  await TestUtils.waitForCondition(() => view.splits.shown === 2, "S2 shows");
  const before = view.splits;
  const result = await state(4);
  const id = (tab) => String(tab.linkedBrowser.browserId);
  const index = (tab) => result.tabs.findIndex((t) => t.id === id(tab));
  const row = (x, y) => ({
    axis: "x",
    ratios: [0.5, 0.5],
    children: [
      { tab: id(x), index: index(x) },
      { tab: id(y), index: index(y) },
    ],
  });
  Assert.deepEqual(
    result.splits,
    [
      { number: 1, shown: false, focus: id(a), zoomed: false, root: row(a, b) },
      { number: 2, shown: true, focus: id(d), zoomed: false, root: row(c, d) },
    ],
    "both splits in number order, tab ids and places only",
  );
  Assert.deepEqual(
    result.panes,
    { focus: id(d), zoomed: false, hidden: false, root: row(c, d) },
    "panes is the shown split",
  );
  Assert.equal(view.splits.shown, before.shown, "state changed nothing (read-only)");
  Assert.deepEqual(view.splits.splits, before.splits, "the splits are the same");

  gBrowser.selectedTab = lone;
  const hidden = await state(5);
  Assert.deepEqual(
    hidden.splits.map((x) => [x.number, x.shown]),
    [
      [1, false],
      [2, false],
    ],
    "a lone tab: none shown",
  );
  Assert.equal(hidden.panes.hidden, true, "panes: the split shown last, hidden");
  Assert.equal(hidden.panes.focus, id(d), "S2's focus");

  client.close();
  await disable();
  for (const t of tabs) gBrowser.removeTab(t);
  await TestUtils.waitForCondition(() => !view.panes, "no split left");
  await SpecialPowers.popPrefEnv();
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
});

add_task(async function test_send_keys_reach_the_page() {
  await enable();
  const client = await session();
  await BrowserTestUtils.withNewTab("https://example.com/", async (browser) => {
    await recordPageKeys(browser);
    await focusContent(browser);
    const r = await client.request(1, "send-keys", { keys: "j shift+k" });
    Assert.deepEqual(r.result, { sent: 2 }, "two chords sent");
    Assert.ok(await waitForPageKey(browser, ["K"]), "the page received the unbound key");
    // Like a real j in normal mode: Vimma takes it (scroll), so the page never sees it.
    Assert.deepEqual(VimmaHost._lastChords.slice(-2), ["j", "shift+k"], "Vimma saw both");
    Assert.deepEqual(await pageKeys(browser), ["Shift", "K"], "as real key presses");
  });
  client.close();
  await disable();
});

add_task(async function test_open() {
  await enable();
  const client = await session();
  const before = gBrowser.tabs.length;

  const url = "https://example.com/";
  const loaded = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  const r = await client.request(1, "open", { url });
  const tab = await loaded;
  Assert.equal(gBrowser.tabs.length, before + 1, "a new tab");
  Assert.equal(gBrowser.selectedTab, tab, "in the foreground");
  Assert.equal(r.result.tab, String(tab.linkedBrowser.browserId), "result names the tab");
  Assert.ok(
    tab.linkedBrowser.contentPrincipal.isContentPrincipal,
    "the page loads with its own content principal",
  );

  const current = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, "about:blank");
  const r2 = await client.request(2, "open", { url: "about:blank", where: "current" });
  await current;
  Assert.equal(gBrowser.tabs.length, before + 1, "where: current reuses the selected tab");
  Assert.equal(r2.result.tab, r.result.tab, "the same tab");
  BrowserTestUtils.removeTab(tab);

  // The e2e harness's happy path: about:blank in a new, selected tab, not the new-tab page.
  const blank = BrowserTestUtils.waitForNewTab(gBrowser, "about:blank", true);
  const r3 = await client.request(6, "open", { url: "about:blank" });
  const blankTab = await blank;
  Assert.equal(gBrowser.selectedTab, blankTab, "selected");
  Assert.equal(r3.result.tab, String(blankTab.linkedBrowser.browserId), "result names it");
  const { result } = await client.request(7, "state");
  Assert.deepEqual(
    result.tabs.filter((t) => t.selected).map((t) => t.url),
    ["about:blank"],
    "state shows it selected at about:blank",
  );
  BrowserTestUtils.removeTab(blankTab);

  for (const [id, bad] of [
    [3, "javascript:alert(1)"],
    [4, "data:text/html,<script>alert(1)</script>"],
    [5, "chrome://browser/content/browser.xhtml"],
  ]) {
    const refused = await client.request(id, "open", { url: bad });
    Assert.equal(refused.error?.code, "invalid-args", `${bad.split(":")[0]}: is refused`);
  }
  Assert.equal(gBrowser.tabs.length, before, "nothing opened");
  client.close();
  await disable();
});

add_task(async function test_limits() {
  const { port, token } = await enable();

  // Eight authenticated connections are allowed; the ninth's hello gets busy and a close.
  const open = [];
  for (let i = 0; i < 8; i++) open.push(await session());
  Assert.equal(VimmaControl.connections, 8, "8 authenticated");
  const ninth = new Client(port);
  const busy = await ninth.hello(token);
  Assert.equal(busy?.error?.code, "busy", "the ninth connection is told busy");
  Assert.equal(busy.id, null, "with id null");
  Assert.ok(!busy.error.message.startsWith("busy"), `no doubled code: ${busy.error.message}`);
  Assert.equal(await ninth.closed, 0, "and closed");
  open.pop().close();
  await TestUtils.waitForCondition(() => VimmaControl.connections === 7, "one closed");
  const tenth = new Client(port);
  Assert.equal((await tenth.hello(token)).type, "welcome", "a freed slot is usable");
  tenth.close();
  open.forEach((c) => c.close());
  await TestUtils.waitForCondition(() => VimmaControl.connections === 0, "all closed");

  // Connections that never say hello cannot crowd out a client with the token: at most two wait
  // for a hello, and a new one evicts the oldest (security.md S5; a reconnect loop would otherwise
  // make every vimma-ctl call busy).
  const flood = [];
  for (let i = 0; i < 40; i++) flood.push(new Client(port));
  // All but the 2 newest are evicted: up to 16 linger 1 s to deliver their "busy", the rest
  // close at once. (Connects beyond the listen backlog may only arrive seconds later.)
  let maxClosing = 0;
  await TestUtils.waitForCondition(() => {
    maxClosing = Math.max(maxClosing, VimmaControl.closing);
    return flood.filter((c) => c.closedWith !== null).length >= 22;
  }, "evictions beyond the lingering cap close at once");
  Assert.lessOrEqual(maxClosing, 16, `at most 16 refused connections linger (${maxClosing})`);
  Assert.lessOrEqual(VimmaControl.waiting, 2, "at most two wait for a hello");
  const evicted = flood[0].lines[0] && JSON.parse(flood[0].lines[0]);
  Assert.equal(evicted?.error?.code, "busy", "an evicted connection is told busy");
  const authed = await session();
  Assert.equal((await authed.request(1, "state")).ok, true, "a client with the token gets in");
  authed.close();
  flood.forEach((c) => c.close());
  await TestUtils.waitForCondition(() => VimmaControl.waiting === 0, "flood closed");

  // An oversized line: an error, then a close, without waiting for its newline.
  const big = await session();
  const oversized = big.writeRaw("x".repeat(MAX_LINE_LENGTH + 2));
  Assert.equal((await big.read())?.error?.code, "bad-request", "an oversized line is an error");
  Assert.equal(await big.closed, 0, "and closes the connection");
  await oversized.catch(() => {});

  // Idle: no request within the (shortened) timeout closes without a message.
  await SpecialPowers.pushPrefEnv({ set: [[IDLE_TIMEOUT, 500]] });
  const idle = await session();
  Assert.equal(await idle.closed, 0, "an idle connection is closed");
  Assert.equal(idle.lines.length, 0, "without a message");
  await SpecialPowers.popPrefEnv();

  // No hello within the deadline: an error, then a close.
  await SpecialPowers.pushPrefEnv({ set: [[HELLO_TIMEOUT, 300]] });
  const silent = new Client(port);
  Assert.equal((await silent.read())?.error?.code, "bad-request", "no hello in time");
  Assert.equal(await silent.closed, 0, "closed");
  // The deadline covers the whole handshake: a hello without an auth is closed too.
  const halfway = new Client(port);
  await halfway.send({ type: "hello", protocol: 1, nonce: randomHex() });
  Assert.equal((await halfway.read())?.type, "challenge", "challenged");
  Assert.equal((await halfway.read())?.error?.code, "bad-request", "no auth in time");
  Assert.equal(await halfway.closed, 0, "closed");
  await SpecialPowers.popPrefEnv();
  await disable();
});

/** tools/vimma-ctl's binary in this checkout, found through the symlinked test file. */
async function vimmaCtlPath() {
  const fromEnv = Services.env.get("VIMMA_CTL");
  if (fromEnv) return fromEnv;
  const self = getChromeDir(getResolvedURI(gTestPath));
  self.append(gTestPath.split("/").pop());
  self.normalize(); // resolves `surfer import`'s symlink into the repository
  const repo = self.parent.parent.parent; // tests/browser/<file>
  for (const profile of ["release", "debug"]) {
    const bin = PathUtils.join(repo.path, "tools", "vimma-ctl", "target", profile, "vimma-ctl");
    if (await IOUtils.exists(bin)) return bin;
  }
  return null;
}

add_task(async function test_vimma_ctl_end_to_end() {
  const bin = await vimmaCtlPath();
  if (!bin) {
    Assert.ok(
      Services.env.get("VIMMA_REQUIRE_CTL") !== "1",
      "VIMMA_REQUIRE_CTL=1 (CI) needs tools/vimma-ctl built: cargo build --release",
    );
    info("skipped: no tools/vimma-ctl/target/{release,debug}/vimma-ctl; cargo build --release");
    return;
  }
  await enable();
  const { exitCode, out } = await runVimmaCtl(bin, ["state", "--json"]);
  Assert.equal(exitCode, 0, `vimma-ctl state exits 0: ${out}`);
  const state = JSON.parse(out);
  Assert.equal(state.mode, "normal", "vimma-ctl reads the live state");
  Assert.equal(state.tabs.length, gBrowser.visibleTabs.length, "with every tab");
  // The Omarchy hook's fallback (omarchy/vimma-theme-reload.sh); browser.toml pins the built-in
  // theme here.
  const reload = await runVimmaCtl(bin, ["reload-theme"]);
  Assert.deepEqual(reload, { exitCode: 0, out: "unchanged\n" }, "vimma-ctl reload-theme");

  // A flood of connections that never say hello does not lock vimma-ctl out.
  const { port } = await readDiscovery();
  const flood = [];
  for (let i = 0; i < 30; i++) flood.push(new Client(port));
  for (let i = 0; i < 5; i++) {
    const run = await runVimmaCtl(bin, ["state"]);
    Assert.equal(run.exitCode, 0, `vimma-ctl state during a flood, run ${i}: ${run.out}`);
  }
  flood.forEach((c) => c.close());
  await disable();

  // A squatter on a stale discovery file's port, without the token: vimma-ctl refuses it and
  // sends no command.
  const squatter = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
  squatter.init(-1, true, 4);
  const received = [];
  squatter.asyncListen({
    onSocketAccepted(_s, transport) {
      const input = transport.openInputStream(0, 0, 0);
      const output = transport.openOutputStream(0, 0, 0);
      const sis = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
        Ci.nsIScriptableInputStream,
      );
      sis.init(input);
      input.QueryInterface(Ci.nsIAsyncInputStream).asyncWait(
        {
          onInputStreamReady() {
            try {
              received.push(sis.read(sis.available()));
            } catch {
              return;
            }
            const line = '{"type":"challenge","protocol":1,"proof":"' + "0".repeat(64) + '"}\n';
            output.write(line, line.length);
            input.QueryInterface(Ci.nsIAsyncInputStream).asyncWait(
              {
                onInputStreamReady() {
                  try {
                    received.push(sis.read(sis.available()));
                  } catch {
                    // closed: vimma-ctl hung up without sending anything more
                  }
                },
              },
              0,
              0,
              Services.tm.mainThread,
            );
          },
        },
        0,
        0,
        Services.tm.mainThread,
      );
    },
    onStopListening() {},
  });
  const stale = {
    protocol: 1,
    port: squatter.port,
    token: randomHex(),
    pid: Services.appinfo.processID,
  };
  const tmp = await IOUtils.createUniqueFile(PathUtils.profileDir, "stale.tmp", 0o600);
  await IOUtils.writeUTF8(tmp, JSON.stringify(stale));
  await IOUtils.move(tmp, DISCOVERY);
  const refused = await runVimmaCtl(bin, ["send-keys", "s e c r e t"]);
  squatter.close();
  await IOUtils.remove(DISCOVERY);
  Assert.equal(refused.exitCode, 4, `vimma-ctl refuses the squatter: ${refused.out}`);
  Assert.ok(
    !received.join("").includes("send-keys") && !received.join("").includes(stale.token),
    `neither the token nor a command reached the squatter: ${received.join("")}`,
  );
});

/** An Omarchy colors.toml: Tokyo Night with the status bar's colour (dark_background) set. */
function colorsToml(/** @type {string} */ darkBackground) {
  const palette = { ...TOKYO_NIGHT, dark_background: darkBackground };
  return Object.entries(palette)
    .map(([key, value]) => `${key} = "${value}"`)
    .join("\n");
}

/** "#rrggbb" → "rgb(r, g, b)", as getComputedStyle reports it. */
function rgb(/** @type {string} */ hex) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

const barBackground = () =>
  getComputedStyle(document.getElementById("vimma-statusbar")).backgroundColor;

add_task(async function test_reload_theme() {
  // Spec m5-omarchy-theme, "Instant reload": Omarchy's theme-set hook runs
  // `vimma-ctl reload-theme`; the browser reads the theme at once, not at the next poll.
  const dir = await IOUtils.createUniqueDirectory(PathUtils.tempDir, "vimma-theme-reload");
  const colors = PathUtils.join(dir, "colors.toml");
  await IOUtils.writeUTF8(colors, colorsToml("#101820"));
  await SpecialPowers.pushPrefEnv({
    set: [
      // An hour: within this test only reload-theme reads the file again.
      ["vimma.theme.pollMs", 3600000],
      ["vimma.theme.omarchyPath", dir],
      ["vimma.theme.source", "omarchy"],
    ],
  });
  await TestUtils.waitForCondition(
    () => barBackground() === rgb("#101820"),
    "the first theme applies (a pref change re-reads at once)",
  );
  // The next theme. Same size, and the mtime may well match: reload-theme reads regardless.
  await IOUtils.writeUTF8(colors, colorsToml("#301030"));

  const { port, token } = await enable();
  const before = barBackground();

  const noHello = new Client(port);
  await noHello.send({ type: "request", id: 1, command: "reload-theme", args: {} });
  Assert.equal((await noHello.read())?.error?.code, "bad-request", "no request before hello");
  Assert.equal(await noHello.closed, 0, "and closed");

  const noAuth = new Client(port);
  await noAuth.send({ type: "hello", protocol: 1, nonce: randomHex() });
  Assert.equal((await noAuth.read())?.type, "challenge", "a hello is challenged");
  await noAuth.send({ type: "request", id: 1, command: "reload-theme", args: {} });
  Assert.equal((await noAuth.read())?.error?.code, "bad-request", "no request before auth");
  Assert.equal(await noAuth.closed, 0, "and closed");

  const wrong = new Client(port);
  const refused = await wrong.hello(
    token.replace(/^./, (c) => (c === "0" ? "1" : "0")),
    { checkProof: false },
  );
  Assert.equal(refused?.error?.code, "unauthorized", "a wrong token is refused");
  Assert.equal(await wrong.closed, 0, "and closed before any request");
  Assert.equal(barBackground(), before, "no unauthenticated client reloaded the theme");

  const client = await session();
  const reloaded = await client.request(1, "reload-theme");
  Assert.deepEqual(reloaded.result, { changed: true }, "the new theme was read");
  // No waiting: the reply comes after the new sheet is in every window.
  Assert.equal(barBackground(), rgb("#301030"), "the bar shows it when the reply arrives");

  const again = await client.request(2, "reload-theme");
  Assert.deepEqual(again.result, { changed: false }, "an unchanged file changes nothing");
  const typo = await client.request(3, "reload-theme", { path: colors });
  Assert.equal(typo.error.code, "invalid-args", "reload-theme takes no path");
  client.close();
  await disable();
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(() => {
    // the built-in vimma palette, in the variant the window's colour scheme picks
    const light = window.matchMedia("(prefers-color-scheme: light)").matches;
    const { dark, light: lightPalette } = BUILTIN_THEMES.vimma;
    return barBackground() === rgb((light ? lightPalette : dark).dark_background);
  }, "back to the built-in theme");
  await IOUtils.remove(dir, { recursive: true });
});

add_task(async function test_server_checks_the_scheme_itself() {
  // Not only the shared validator: the command re-parses the URL (security.md S10).
  for (const url of ["javascript:alert(1)", "data:text/html,x", "chrome://browser/content/"]) {
    let code = null;
    try {
      VimmaControl._commands.open({ url });
    } catch (e) {
      code = e.code;
    }
    Assert.equal(code, "invalid-args", `${url.split(":")[0]}: refused by the server itself`);
  }
});

add_task(async function test_stale_discovery_file_removed_at_start() {
  // A file left by a crash goes at the next start, even with the socket off.
  Services.prefs.setBoolPref(ENABLED, false);
  await VimmaControl._restartForTests(window, async () => {
    await IOUtils.writeUTF8(DISCOVERY, '{"protocol":1,"port":1,"token":"x","pid":1}');
  });
  Assert.ok(!(await IOUtils.exists(DISCOVERY)), "the stale file is removed with the pref off");
  Assert.equal(VimmaControl.port, null, "and nothing listens");

  // A directory there is left alone and the server does not start (no file moved into it).
  await VimmaControl._restartForTests(window, () => IOUtils.makeDirectory(DISCOVERY));
  Services.prefs.setBoolPref(ENABLED, true);
  await VimmaControl.settled();
  Assert.equal(VimmaControl.port, null, "no server over a directory");
  Assert.equal((await IOUtils.stat(DISCOVERY)).type, "directory", "the directory is untouched");
  Assert.deepEqual(await IOUtils.getChildren(DISCOVERY), [], "and nothing was moved into it");
  await disable();
  await IOUtils.remove(DISCOVERY, { recursive: true });

  if (AppConstants.platform === "linux") {
    // A symlink to a directory: the link is removed, not followed; the target is untouched.
    const target = PathUtils.join(PathUtils.profileDir, "vimma-control-target");
    await IOUtils.makeDirectory(target);
    await VimmaControl._restartForTests(window, async () => {
      const ln = await Subprocess.call({
        command: "/usr/bin/ln",
        arguments: ["-s", target, DISCOVERY],
      });
      Assert.equal((await ln.wait()).exitCode, 0, "symlink made");
    });
    const { port } = await enable();
    Assert.ok(port, "the server starts in place of the link");
    Assert.deepEqual(await IOUtils.getChildren(target), [], "the link's target is untouched");
    await disable();
    await IOUtils.remove(target, { recursive: true });
  }
});

add_task(async function test_shutdown_does_not_wait_for_a_window_that_never_started() {
  // The first window closed before its delayed startup: quitting must not hang on it.
  const neverReady = { gBrowserInit: { delayedStartupFinished: false } };
  Services.prefs.setBoolPref(ENABLED, true);
  await VimmaControl._restartForTests(neverReady);
  const done = await Promise.race([
    VimmaControl.shutdown().then(() => "done"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 3000)),
  ]);
  Assert.equal(done, "done", "shutdown finishes");
  Assert.ok(!(await IOUtils.exists(DISCOVERY)), "no discovery file");
  Assert.equal(VimmaControl.port, null, "no server");
  Services.prefs.setBoolPref(ENABLED, false);
  await VimmaControl._restartForTests(window);
});
