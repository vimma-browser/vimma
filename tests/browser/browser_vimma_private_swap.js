/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spec: docs/specs/private-swap.md (ADR-017). On Hyprland the private workspace takes the
// normal Vimma window's place: the normal window is parked in special:vimma and the private
// window gets its workspace, tile, size and fullscreen state; going back swaps again. Hyprland
// here is a fake: two Unix sockets (nsIServerSocket.initWithFilename) with a small model of
// clients and workspaces that applies the commands it gets and records every byte. The real
// environment is never used or changed.

"use strict";

const { NAME_MS, PrivateSwap } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/private-swap.mjs",
);
const { PARK, encodeBatch, parseClients, planShow, isAllowedRequest } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/core/hyprswap.mjs",
);
const { REPLY_MS } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/hypr/HyprIpc.sys.mjs",
);
const { AboutVimma } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/about/AboutVimma.sys.mjs",
);
const { togglePrivate } = ChromeUtils.importESModule(
  "chrome://browser/content/vimma/host/private-ops.mjs",
);
const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
);

/** A Unix-socket server at `file` (netwerk/test/unit/test_unix_domain.js does the same). */
function unixServer(file) {
  const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
  server.initWithFilename(file, 0o600, -1);
  return server;
}

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com",
);
const TITLED = `${ROOT}file_vimma_title.html`;
const PAGE_TITLE = "Vimma status bar test page";
/** A title only the fake's own events carry: it must never reach the console. */
const EVENT_TITLE = "vimmaswap-event-title-secret";
const NOTICE_ID = "vimma-notice";
const PROMPT_ID = "vimma-rename";
const BROWSER_DOC = "chrome://browser/content/browser.xhtml";
/** The normal window's slot before any switch. */
const SLOT = { workspace: { id: 3, name: "3" }, at: [12, 43], size: [1256, 745] };

/** @param {() => boolean} cond @param {string} msg */
function until(cond, msg) {
  return TestUtils.waitForCondition(cond, msg, 25, 200);
}

/** Every open private window, pop-ups included. */
function privateWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(
    (w) => !w.closed && PrivateBrowsingUtils.isWindowPrivate(w),
  );
}

/** ctrl+b, then `key` with `mods`, in `win`. */
function prefix(key, mods = {}, win = window) {
  EventUtils.synthesizeKey("b", { ctrlKey: true }, win);
  EventUtils.synthesizeKey(key, mods, win);
}

/** @param {string} s  UTF-8 bytes as a binary string, for nsIOutputStream.write */
function utf8(s) {
  let out = "";
  for (const b of new TextEncoder().encode(s)) out += String.fromCharCode(b);
  return out;
}

/** A short temp dir: a Unix socket path must stay under 107 bytes. */
function shortDir() {
  const dir = Services.dirsvc.get("TmpD", Ci.nsIFile);
  dir.append(`vh${Math.random().toString(36).slice(2, 8)}`);
  dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  return dir;
}

/**
 * The fake Hyprland. Discovers every browser window, gives it an address, and answers
 * `j/clients` with each window's chrome title (as Hyprland does); emits `windowtitlev2` when a
 * window's title changes, `movewindowv2` on moves and `closewindow` when one closes.
 */
class FakeHypr {
  /**
   * @param {{ mode?: "lua" | "silent" | "errors" | "hangup" | "open-on-nonce" | "nameless",
   *   delayMoves?: number, delayNames?: number }} [options]  hangup: closes every request
   *   unanswered; open-on-nonce: a window is announced only by openwindow, with its nonce title,
   *   and j/clients never shows that title; nameless: a nonce title never reaches Hyprland (its
   *   events and j/clients show "Vimma" instead); delayMoves: movewindowv2 comes this many ms
   *   late; delayNames: open-on-nonce's openwindow comes this many ms late, as on a busy machine
   */
  constructor({ mode = "lua", delayMoves = 0, delayNames = 0 } = {}) {
    this.mode = mode;
    this.delayMoves = delayMoves;
    this.delayNames = delayNames;
    this.reqAccepts = 0;
    this.evAccepts = 0;
    /** What j/activeworkspace answers. */
    this.active = { id: 7, name: "7" };
    this.dir = shortDir();
    /** Every request, as received. @type {string[]} */
    this.received = [];
    /** Batches with the clients reply that preceded each. */
    this.batches = /** @type {{ text: string, before: string }[]} */ ([]);
    this.lastClients = "[]";
    /** @type {Map<string, any>} */
    this.clients = new Map();
    /** @type {WeakMap<Window, string>} */
    this.addr = new WeakMap();
    this.titles = new Map();
    this.next = 0x5a0001;
    /** Verbs that fail, to test the fallback. @type {Set<string>} */
    this.failing = new Set();
    /** Called with each batch before it is applied. @type {((text: string) => void) | null} */
    this.onBatch = null;
    this.events = /** @type {any[]} */ ([]);
    this.held = /** @type {any[]} */ ([]);
    const req = this.dir.clone();
    req.append(".socket.sock");
    const ev = this.dir.clone();
    ev.append(".socket2.sock");
    this.sockets = { request: req.path, events: ev.path };
    this.reqServer = unixServer(req);
    this.reqServer.asyncListen({
      onSocketAccepted: (_s, t) => this.accept(t),
      onStopListening() {},
    });
    this.evServer = unixServer(ev);
    this.evServer.asyncListen({
      onSocketAccepted: (_s, t) => {
        this.evAccepts++;
        this.events.push({ t, out: t.openOutputStream(Ci.nsITransport.OPEN_UNBUFFERED, 0, 0) });
      },
      onStopListening() {},
    });
    this.timer = setInterval(() => this.poll(), 20);
    this.poll();
  }

  /** @param {any} t */
  accept(t) {
    this.reqAccepts++;
    this.held.push(t);
    if (this.mode === "hangup") {
      t.close(Cr.NS_OK);
      return;
    }
    const flags = Ci.nsITransport.OPEN_UNBUFFERED;
    const input = t.openInputStream(flags, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
    const out = t.openOutputStream(flags, 0, 0);
    input.asyncWait(
      {
        onInputStreamReady: (stream) => {
          let bytes;
          try {
            const s = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
              Ci.nsIScriptableInputStream,
            );
            s.init(stream);
            bytes = s.readBytes(s.available());
          } catch {
            return;
          }
          const text = new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
          this.received.push(text);
          if (this.mode === "silent") return;
          const reply = utf8(this.handle(text));
          let sent = 0;
          const write = () => {
            try {
              sent += out.write(reply.slice(sent), reply.length - sent);
            } catch {
              // the client went away
            }
            if (sent < reply.length) {
              out
                .QueryInterface(Ci.nsIAsyncOutputStream)
                .asyncWait({ onOutputStreamReady: write }, 0, 0, Services.tm.mainThread);
            } else {
              out.close();
              t.close(Cr.NS_OK);
            }
          };
          write();
        },
      },
      0,
      0,
      Services.tm.mainThread,
    );
  }

  /** @param {string} line */
  emit(line) {
    const bytes = utf8(`${line}\n`);
    for (const e of this.events) {
      try {
        e.out.write(bytes, bytes.length);
      } catch {
        // a closed listener
      }
    }
  }

  /** A movewindowv2, late with `delayMoves` as Hyprland's can be after its reply. */
  emitMove(line) {
    if (this.delayMoves) setTimeout(() => this.emit(line), this.delayMoves);
    else this.emit(line);
  }

  /** Hyprland restarting its event socket: every listener is cut off. */
  dropEvents() {
    for (const e of this.events) e.t.close(Cr.NS_OK);
    this.events = [];
  }

  /** @param {Window} win */
  rec(win) {
    return this.clients.get(this.addr.get(win));
  }

  poll() {
    const open = new Set();
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed) continue;
      // As on Wayland, Hyprland has the window once its browser document is up: a title set on
      // the initial about:blank that OpenBrowserWindow returns never reaches it.
      if (win.document.documentURI !== BROWSER_DOC) continue;
      let a = this.addr.get(win);
      if (!a) {
        a = `0x${(this.next++).toString(16)}`;
        this.addr.set(win, a);
        const first = this.clients.size === 0;
        this.clients.set(a, {
          address: a,
          win: new WeakRef(win),
          pid: Services.appinfo.processID,
          workspace: { ...SLOT.workspace },
          floating: false,
          fullscreen: 0,
          fullscreenClient: 0,
          grouped: [],
          pinned: false,
          at: first ? [...SLOT.at] : [647, 43],
          size: first ? [...SLOT.size] : [621, 745],
        });
        if (this.mode !== "open-on-nonce") {
          this.emit(`openwindow>>${a.slice(2)},3,vimma-vimma,${EVENT_TITLE}`);
        }
      }
      open.add(a);
      const real = win.document.title;
      const nameless = this.mode === "nameless" && /^vimma-[0-9a-f]{32}$/.test(real);
      const title = nameless ? "Vimma" : real;
      if (this.titles.get(a) !== title) {
        // open-on-nonce announces a nonce once and j/clients never shows it, so a line sent
        // before the event socket is accepted could never be recovered: wait for a listener.
        const once = this.mode === "open-on-nonce" && /^vimma-[0-9a-f]{32}$/.test(title);
        if (once && !this.events.length) continue;
        this.titles.set(a, title);
        if (this.mode !== "open-on-nonce") this.emit(`windowtitlev2>>${a.slice(2)},${title}`);
        else if (/^vimma-[0-9a-f]{32}$/.test(title)) {
          const line = `openwindow>>${a.slice(2)},3,vimma-vimma,${title}`;
          if (this.delayNames) setTimeout(() => this.emit(line), this.delayNames);
          else this.emit(line);
        }
      }
    }
    for (const a of [...this.clients.keys()]) {
      if (!open.has(a)) {
        this.clients.delete(a);
        this.emit(`closewindow>>${a.slice(2)}`);
      }
    }
  }

  /** @param {string} text */
  handle(text) {
    if (this.mode === "errors") return "error: nope";
    if (text === "j/version") return JSON.stringify({ version: "0.56.2", tag: "v0.56.2" });
    if (text === "j/activeworkspace") return JSON.stringify(this.active);
    if (text === "j/clients") {
      this.poll();
      // An unrelated app's window, whose title must never travel further.
      const other = {
        address: "0xabc",
        pid: 1,
        title: EVENT_TITLE,
        workspace: { id: 2, name: "2" },
        at: [0, 0],
        size: [10, 10],
      };
      this.lastClients = JSON.stringify([
        ...[...this.clients.values()].map((c) => ({
          ...c,
          win: undefined,
          title: this.mode === "open-on-nonce" ? "Vimma" : (this.titles.get(c.address) ?? ""),
        })),
        other,
      ]);
      return this.lastClients;
    }
    if (text.startsWith("[[BATCH]]")) {
      this.onBatch?.(text);
      this.batches.push({ text, before: this.lastClients });
      return text
        .slice(9)
        .split(";")
        .map((c) => this.apply(c))
        .join("\n\n\n");
    }
    return this.apply(text);
  }

  /** @param {string} ws */
  ws(ws) {
    if (ws === `"${PARK}"`) return { id: -98, name: PARK };
    const named = /^"name:(.+)"$/.exec(ws);
    if (named) return { id: -1337, name: named[1] };
    return { id: Number(ws), name: ws };
  }

  /** @param {string} cmd */
  apply(cmd) {
    const W = String.raw`window = "address:(0x[0-9a-f]+)"`;
    let m;
    const get = (/** @type {string} */ a) => this.clients.get(a);
    const fail = (/** @type {string} */ verb) =>
      this.failing.has(verb) ? `error: ${verb} refused` : null;
    if (cmd === "dispatch hl.dsp.no_op()") return "ok";
    if (
      (m = new RegExp(
        `^dispatch hl\\.dsp\\.window\\.move\\(\\{ workspace = (.+?), follow = false, ${W} \\}\\)$`,
      ).exec(cmd))
    ) {
      const c = get(m[2]);
      if (!c) return "warning: window not found";
      c.workspace = this.ws(m[1]);
      this.emitMove(`movewindowv2>>${m[2].slice(2)},${c.workspace.id},${c.workspace.name}`);
      return "ok";
    }
    if (
      (m = new RegExp(
        `^dispatch hl\\.dsp\\.window\\.swap\\(\\{ ${W}, other = "address:(0x[0-9a-f]+)" \\}\\)$`,
      ).exec(cmd))
    ) {
      const a = get(m[1]);
      const b = get(m[2]);
      if (!a || !b) return "warning: hl.window.swap: target window not found";
      if (fail("swap")) return fail("swap");
      for (const k of ["workspace", "at", "size"]) [a[k], b[k]] = [b[k], a[k]];
      return "ok";
    }
    if ((m = new RegExp(`^dispatch hl\\.dsp\\.focus\\(\\{ ${W} \\}\\)$`).exec(cmd))) {
      const c = get(m[1]);
      if (!c) return "warning: window not found";
      this.focused = m[1];
      // Hyprland's focus gives the window keyboard focus; GTK's focus-in activates it.
      const win = c.win.deref();
      this.focusing = true;
      win?.focus();
      this.focusing = false;
      return "ok";
    }
    if (
      (m = new RegExp(
        `^dispatch hl\\.dsp\\.window\\.fullscreen_state\\(\\{ internal = (\\d), client = (\\d), ${W} \\}\\)$`,
      ).exec(cmd))
    ) {
      const c = get(m[3]);
      if (!c) return "warning: window not found";
      c.fullscreen = Number(m[1]);
      c.fullscreenClient = Number(m[2]);
      return "ok";
    }
    if (
      (m = new RegExp(
        `^dispatch hl\\.dsp\\.window\\.float\\(\\{ action = "(enable|disable)", ${W} \\}\\)$`,
      ).exec(cmd))
    ) {
      const c = get(m[2]);
      if (!c) return "warning: window not found";
      c.floating = m[1] === "enable";
      return "ok";
    }
    if (
      (m = new RegExp(
        `^dispatch hl\\.dsp\\.window\\.(resize|move)\\(\\{ x = (-?\\d+), y = (-?\\d+), ${W} \\}\\)$`,
      ).exec(cmd))
    ) {
      const c = get(m[4]);
      if (!c) return "warning: window not found";
      c[m[1] === "resize" ? "size" : "at"] = [Number(m[2]), Number(m[3])];
      return "ok";
    }
    return "error: unknown dispatcher";
  }

  /** The user moving a window with their own key (decision 7). */
  userMove(win, id, name = String(id)) {
    const c = this.rec(win);
    c.workspace = { id, name };
    this.emit(`movewindowv2>>${c.address.slice(2)},${id},${name}`);
  }

  stop() {
    clearInterval(this.timer);
    this.reqServer.close();
    this.evServer.close();
    for (const e of this.events) e.t.close(Cr.NS_OK);
    for (const t of this.held) t.close(Cr.NS_OK);
    try {
      this.dir.remove(true);
    } catch {
      // the sockets go with the servers
    }
  }
}

/** @type {FakeHypr | null} */
let fake = null;

/** A fresh fake (or `sockets` for the no-Hyprland cases) and a fresh PrivateSwap. */
async function start(options = {}, sockets, reset = {}) {
  await teardown();
  fake = sockets === undefined ? new FakeHypr(options) : null;
  PrivateSwap._resetForTests(fake ? fake.sockets : sockets, reset);
  return fake;
}

/** Closes every private window, lets the swaps settle, and goes back to the environment. */
async function teardown() {
  for (const w of privateWindows()) await BrowserTestUtils.closeWindow(w);
  await PrivateSwap._settled();
  await new Promise((r) => setTimeout(r, 50));
  PrivateSwap._resetForTests(undefined);
  fake?.stop();
  fake = null;
  await SimpleTest.promiseFocus(window);
}

registerCleanupFunction(teardown);

/**
 * Counts focus() calls on `win` made while the fake has it parked (decision 1 of the
 * mechanism: a parked window is never focused, or its special workspace would open).
 * @param {Window} win
 */
function spyParkedFocus(win) {
  const real = win.focus;
  const spy = { calls: 0, restore: () => (win.focus = real) };
  win.focus = function () {
    if (!fake?.focusing && fake?.rec(win)?.workspace.name === PARK) spy.calls++;
    return real.call(this);
  };
  return spy;
}

/** @param {Window} win */
const parked = (win) => fake.rec(win)?.workspace.name === PARK;

/** @param {Window} win */
function inSlot(win, slot = SLOT) {
  const c = fake.rec(win);
  return (
    c?.workspace.id === slot.workspace.id &&
    c.at.join() === slot.at.join() &&
    c.size.join() === slot.size.join()
  );
}

/**
 * ctrl+b shift+p from the normal window; the private window it opened or showed, once it is in
 * `slot`.
 */
async function enter(slot = SLOT) {
  await SimpleTest.promiseFocus(window);
  const opened = privateWindows().length ? null : BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const priv = opened ? await opened : privateWindows()[0];
  await until(() => parked(window) && inSlot(priv, slot), "private is in the normal window's slot");
  await PrivateSwap._settled();
  return priv;
}

add_task(async function entering_swaps_in_place_and_every_way_back_swaps_again() {
  await start();
  const spy = spyParkedFocus(window);
  const priv = await enter();
  Assert.equal(privateWindows().length, 1, "one private window");
  Assert.ok(parked(window), "the normal window waits in special:vimma");
  Assert.ok(inSlot(priv), "private has the normal window's workspace, position and size");
  Assert.equal(fake.focused, fake.rec(priv).address, "Hyprland focused the private window");
  Assert.deepEqual(PrivateSwap._pair?.parked, "normal");

  // The batch sent is exactly core's plan for the clients read just before it.
  const [{ text, before }] = fake.batches;
  const list = parseClients(before);
  const find = (/** @type {Window} */ w) => list.find((c) => c.address === fake.addr.get(w));
  Assert.equal(text, encodeBatch("lua", planShow("lua", find(priv), find(window)).commands).text);

  // Back by each route: the toggle, ctrl+^, ctrl+b ).
  const routes = [
    ["the toggle", () => prefix("P", { shiftKey: true }, priv)],
    ["ctrl+^", () => prefix("^", { shiftKey: true, code: "Digit6" }, priv)],
    ["ctrl+b )", () => prefix(")", { shiftKey: true }, priv)],
  ];
  for (const [name, press] of routes) {
    await SimpleTest.promiseFocus(priv);
    press();
    await until(() => parked(priv) && inSlot(window), `${name}: normal is back in its slot`);
    await PrivateSwap._settled();
    Assert.equal(fake.focused, fake.rec(window).address, `${name}: Hyprland focused normal`);
    const again = await enter();
    Assert.equal(again, priv, `${name}: going there again shows the same private window`);
  }
  Assert.equal(spy.calls, 0, "no focus() on a parked window");
  // about:vimma (decision 10): the window manager and the placement, no addresses or titles.
  const data = await AboutVimma.collect(window);
  Assert.equal(data.windowManager, "Hyprland 0.56.2 (lua), private placement: swap");
  Assert.ok(AboutVimma.report(data).includes(`Window manager: ${data.windowManager}`));
  spy.restore();
  Assert.equal(privateWindows().length, 1, "still one private window");
});

add_task(async function fullscreen_floating_and_grouped_slots() {
  for (const fs of [1, 2]) {
    const f = await start();
    f.poll();
    Object.assign(f.rec(window), { fullscreen: fs, fullscreenClient: fs });
    const priv = await enter();
    Assert.equal(f.rec(priv).fullscreen, fs, `fullscreen ${fs} moves to the private window`);
    Assert.equal(f.rec(window).fullscreen, 0, "and is unset on the parked one");
    await SimpleTest.promiseFocus(priv);
    prefix("P", { shiftKey: true }, priv);
    await until(() => parked(priv) && f.rec(window).fullscreen === fs, "and back again");
  }

  const f = await start();
  f.poll();
  const float = { workspace: { id: 3, name: "3" }, at: [100, 120], size: [500, 300] };
  Object.assign(f.rec(window), { floating: true, at: float.at, size: float.size });
  const priv = await enter(float);
  Assert.ok(f.rec(priv).floating, "a floating slot: the private window floats there");

  const g = await start();
  g.poll();
  g.rec(window).grouped = [g.rec(window).address, "0x77"];
  await SimpleTest.promiseFocus(window);
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const gp = await opened;
  await until(() => g.focused === g.rec(gp)?.address, "a grouped slot: private is focused");
  await PrivateSwap._settled();
  Assert.ok(!parked(window), "nothing is parked beside a group");
  Assert.equal(PrivateSwap._pair, null, "no pair");
});

add_task(async function closing_the_private_window_any_way_brings_normal_back() {
  for (const how of ["close()", "closeWindow", "ctrl+b shift+d"]) {
    const f = await start();
    const priv = await enter();
    let closedAtSwap = null;
    f.onBatch = () => (closedAtSwap ??= priv.closed);
    if (how === "close()") priv.close();
    else if (how === "closeWindow") await BrowserTestUtils.closeWindow(priv);
    else {
      await SimpleTest.promiseFocus(priv);
      prefix("D", { shiftKey: true }, priv);
      await until(() => priv.document.getElementById(PROMPT_ID)?.hidden === false, "y/N");
      EventUtils.synthesizeKey("y", {}, priv);
    }
    await until(() => priv.closed, `${how}: the private window closed`);
    await until(() => !parked(window) && f.rec(window).workspace.id === 3, `${how}: normal back`);
    if (how === "ctrl+b shift+d") {
      Assert.strictEqual(closedAtSwap, false, "the swap was sent before the window closed");
      Assert.ok(inSlot(window), "in its exact slot");
    }
    await PrivateSwap._settled();
    Assert.equal(PrivateSwap._pair, null, `${how}: the pair is forgotten`);
  }
});

add_task(async function a_link_from_another_app_brings_the_parked_window_back() {
  const f = await start();
  const priv = await enter();
  // As BrowserContentHandler hands an external URL to the most recent normal window.
  const bdw = window.browserDOMWindow;
  bdw.openURI(
    Services.io.newURI("https://example.com/?external"),
    null,
    Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
    Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL,
    Services.scriptSecurityManager.getSystemPrincipal(),
  );
  await until(() => parked(priv) && inSlot(window), "normal swapped back in place");
  Assert.equal(PrivateSwap._pair?.parked, "private", "private waits, one key away");
  await PrivateSwap._settled();
  gBrowser.removeTab(gBrowser.tabs.at(-1));
  Assert.ok(f.received.length > 0);
});

add_task(async function moving_the_parked_window_away_forgets_the_pair() {
  const f = await start();
  const priv = await enter();
  f.userMove(window, 2);
  await until(() => PrivateSwap._pair === null, "the pair is forgotten");
  const batches = f.batches.length;
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => Services.focus.activeWindow === window, "back by focus, as before");
  Assert.equal(f.batches.length, batches, "no swap fights the user");
  Assert.equal(f.rec(window).workspace.id, 2, "the window stays where the user put it");
});

add_task(async function a_refused_swap_shows_the_window_and_says_so_once() {
  const f = await start();
  f.failing.add("swap");
  await SimpleTest.promiseFocus(window);
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const priv = await opened;
  await until(() => f.batches.length >= 2, "the swap and the rescue were sent");
  await PrivateSwap._settled();
  Assert.ok(!parked(window), "the normal window is not left parked");
  Assert.equal(PrivateSwap._pair, null);
  await until(
    () => /refused the swap/.test(priv.document.getElementById(NOTICE_ID)?.textContent ?? ""),
    "the notice says so",
  );
  // Window placement until the next config reload: no more batches.
  const batches = f.batches.length;
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => Services.focus.activeWindow === window, "back as a window");
  Assert.equal(f.batches.length, batches, "no further swap");
});

add_task(async function without_hyprland_everything_is_as_before() {
  const file = shortDir();
  const notSocket = file.clone();
  notSocket.append("file.sock");
  notSocket.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  const missing = file.clone();
  missing.append("nothing");
  const cases = [
    ["no socket", { request: missing.path, events: missing.path }],
    ["a refused connection", { request: notSocket.path, events: notSocket.path }],
    ["a silent server", "silent"],
    ["errors to both probes", "errors"],
    ["no Hyprland in the environment", null],
  ];
  const lines = [];
  const listener = { observe: (m) => lines.push(m.message ?? String(m)) };
  Services.console.registerListener(listener);
  for (const [name, how] of cases) {
    lines.length = 0;
    if (typeof how === "string") await start({ mode: how });
    else await start({}, how);
    await SimpleTest.promiseFocus(window);
    const opened = BrowserTestUtils.waitForNewWindow();
    prefix("P", { shiftKey: true });
    const priv = await opened;
    await until(() => Services.focus.activeWindow === priv, `${name}: the private window`);
    await SimpleTest.promiseFocus(priv);
    prefix("P", { shiftKey: true }, priv);
    await until(() => Services.focus.activeWindow === window, `${name}: back to normal`);
    await SimpleTest.promiseFocus(window);
    prefix("P", { shiftKey: true });
    await until(() => Services.focus.activeWindow === priv, `${name}: and there again`);
    Assert.equal(privateWindows().length, 1, `${name}: one private window`);
    Assert.ok(
      lines.filter((l) => l.includes("vimma: private workspace shown as a window")).length <= 1,
      `${name}: at most one console line`,
    );
    if (fake) {
      const sent = fake.received.filter((r) => r.startsWith("[[BATCH]]"));
      Assert.deepEqual(sent, [], `${name}: no commands`);
    }
  }
  Services.console.unregisterListener(listener);
  file.remove(true);
});

add_task(async function nothing_private_or_titled_is_ever_sent_logged_or_kept() {
  const lines = [];
  const listener = { observe: (m) => lines.push(m.message ?? String(m)) };
  Services.console.registerListener(listener);
  const profile = Services.dirsvc.get("ProfD", Ci.nsIFile);
  const filesBefore = new Set([...profile.directoryEntries].map((f) => f.leafName));
  const f = await start();
  const priv = await enter();
  await BrowserTestUtils.openNewForegroundTab(priv.gBrowser, `${TITLED}?swapleak`);
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => parked(priv), "back");
  await enter();
  await PrivateSwap._settled();
  Services.console.unregisterListener(listener);

  for (const r of f.received) {
    Assert.ok(isAllowedRequest(r), `whitelisted: ${r.slice(0, 60)}`);
    for (const word of [PAGE_TITLE, "swapleak", "example.com", EVENT_TITLE, "Private Browsing"]) {
      Assert.ok(!r.includes(word), `a request does not contain ${word}`);
    }
  }
  Assert.ok(!lines.some((l) => l.includes(EVENT_TITLE)), "no event title in the console");
  const added = [...profile.directoryEntries]
    .map((x) => x.leafName)
    .filter((n) => !filesBefore.has(n) && /vimma|hypr|swap|private/i.test(n));
  Assert.deepEqual(added, [], "no new file about the swap in the profile");
});

add_task(async function the_private_window_title_is_neutral() {
  Assert.equal(
    Services.prefs.getDefaultBranch("").getBoolPref("privacy.exposeContentTitleInWindow.pbm"),
    false,
    "Vimma defaults the private window's title to the brand only",
  );
  await start({}, null);
  const priv = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  await BrowserTestUtils.openNewForegroundTab(priv.gBrowser, TITLED);
  await until(() => /Private Browsing/.test(priv.document.title), "the private title is set");
  Assert.ok(!priv.document.title.includes(PAGE_TITLE), "no page title in the window title");
  await SpecialPowers.pushPrefEnv({ set: [["privacy.exposeContentTitleInWindow.pbm", true]] });
  priv.gBrowser.updateTitlebar();
  Assert.ok(priv.document.title.includes(PAGE_TITLE), "with the pref on, the page title is back");
  await SpecialPowers.popPrefEnv();
  await BrowserTestUtils.closeWindow(priv);
});

add_task(async function placement_window_sends_nothing() {
  const f = await start();
  PrivateSwap.configure("window");
  await SimpleTest.promiseFocus(window);
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const priv = await opened;
  await until(() => Services.focus.activeWindow === priv, "the private window, as a window");
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => Services.focus.activeWindow === window, "back");
  await PrivateSwap._settled();
  Assert.deepEqual(f.received, [], "not even an address lookup");
  Assert.ok(!parked(window));
});

// Going back to the normal window is always instant: whatever the user does with the private
// window, the normal one is never left in special:vimma.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

add_task(async function a_private_window_moved_to_a_scratchpad_still_gives_normal_back() {
  const f = await start();
  const priv = await enter();
  // The user sends the private window to Omarchy's scratchpad: it has no slot to swap into.
  f.userMove(priv, -97, "special:scratchpad");
  await wait(100);
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => !parked(window), "normal is out of special:vimma");
  Assert.equal(f.rec(window).workspace.id, 7, "on the active workspace");
  await PrivateSwap._settled();
  Assert.equal(PrivateSwap._pair, null, "the pair is forgotten");
  Assert.ok(PrivateSwap.status.endsWith("private placement: swap"), "swap is still on");
});

add_task(async function fast_toggling_with_late_move_events_keeps_the_pair() {
  await start({ delayMoves: 80 });
  const priv = await enter();
  await wait(200);
  // Back and there again at once: the first swap's move events arrive after both replies.
  togglePrivate(priv);
  togglePrivate(window);
  await PrivateSwap._settled();
  await wait(300);
  await PrivateSwap._settled();
  Assert.equal(PrivateSwap._pair?.parked, "normal", "our own moves did not end the pair");
  Assert.ok(parked(window) && inSlot(priv), "private is shown, normal parked");
  togglePrivate(priv);
  await until(() => !parked(window) && inSlot(window), "and normal comes back in its slot");
});

add_task(async function nothing_is_sent_before_the_config_says_where() {
  const f = await start({}, undefined, { configured: false });
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await wait(700);
  Assert.deepEqual(f.received, [], "no probe and no nonce title before the config is read");
  PrivateSwap.configure("window");
  await wait(300);
  Assert.deepEqual(f.received, [], "nor with placement = window");
  PrivateSwap.configure("swap");
  await until(() => f.received.includes("j/version"), "the config says swap: Hyprland is asked");
  await BrowserTestUtils.closeWindow(win);
});

add_task(async function the_event_socket_reconnects() {
  const f = await start();
  await enter();
  const before = f.evAccepts;
  PrivateSwap.configure("window");
  PrivateSwap.configure("swap");
  await until(() => f.evAccepts > before, "placement window then swap listens again");
  f.dropEvents();
  const dropped = f.evAccepts;
  const priv = privateWindows()[0];
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => f.evAccepts > dropped, "a switch after Hyprland dropped it listens again");
});

// #163: the drop reaches Vimma as a later main-thread event; a switch that runs before it still
// found the dead listener, and nothing listened again until the switch after.
add_task(async function a_switch_before_the_drop_is_read_still_listens_again() {
  const f = await start();
  await enter();
  const priv = privateWindows()[0];
  await SimpleTest.promiseFocus(priv);
  const before = f.evAccepts;
  f.dropEvents();
  prefix("P", { shiftKey: true }, priv);
  await until(() => f.evAccepts > before, "listens again once the drop is read");
});

add_task(async function a_new_tab_in_the_parked_private_window_shows_nothing_private() {
  const f = await start();
  const priv = await enter();
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => parked(priv) && inSlot(window), "private is parked");
  await PrivateSwap._settled();
  const batches = f.batches.length;
  BrowserTestUtils.addTab(priv.gBrowser, "about:blank");
  await wait(300);
  await PrivateSwap._settled();
  Assert.ok(parked(priv), "the private window stays parked");
  Assert.equal(f.batches.length, batches, "no swap");
});

add_task(async function an_activation_right_after_a_swap_is_the_swap_own() {
  const f = await start();
  await enter();
  // As GTK's late activate for the window just parked (legacy fullscreen focuses it first).
  window.dispatchEvent(new Event("activate"));
  await wait(50);
  await PrivateSwap._settled();
  Assert.ok(parked(window), "a late activation does not undo the swap");
  await wait(500);
  window.dispatchEvent(new Event("activate"));
  await until(() => !parked(window) && inSlot(window), "a later one brings normal back");
  Assert.equal(PrivateSwap._pair?.parked, "private");
  Assert.ok(f.batches.length >= 2);
});

add_task(async function a_refused_connection_is_not_retried() {
  const f = await start({ mode: "hangup" });
  await SimpleTest.promiseFocus(window);
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const priv = await opened;
  await until(() => Services.focus.activeWindow === priv, "the private window, as a window");
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => Services.focus.activeWindow === window, "back");
  await SimpleTest.promiseFocus(window);
  prefix("P", { shiftKey: true });
  await until(() => Services.focus.activeWindow === priv, "there again");
  await wait(100);
  Assert.equal(f.reqAccepts, 1, "Hyprland is asked once, not at every switch");
});

add_task(async function a_window_named_only_by_openwindow_is_found() {
  const f = await start({ mode: "open-on-nonce" });
  const priv = await enter();
  Assert.ok(inSlot(priv) && parked(window), "the swap ran with addresses from openwindow");
  Assert.ok(f.batches.length >= 1);
});

// The nonce's event can come after REPLY_MS while j/clients does not show the title yet: a busy
// machine (the macOS runner, #422) or a window still starting up. The naming keeps waiting.
add_task(async function a_window_named_late_by_openwindow_is_still_found() {
  const f = await start({ mode: "open-on-nonce", delayNames: REPLY_MS + 300 });
  const priv = await enter();
  Assert.ok(inSlot(priv) && parked(window), "the swap ran with addresses from late events");
  Assert.ok(f.batches.length >= 1);
});

add_task(async function a_fresh_private_window_is_named_once_its_document_is_up() {
  // As at a real start: Hyprland was found and the normal window named before the first switch,
  // so nothing waits on the socket while OpenBrowserWindow's window still shows about:blank.
  const f = await start();
  PrivateSwap.configure("swap");
  await until(() => f.received.includes("j/clients"), "the normal window is named at start");
  await PrivateSwap._settled();
  const priv = await enter();
  Assert.ok(parked(window) && inSlot(priv), "the first switch swaps in place");
});

add_task(async function a_window_hyprland_never_names_is_shown_as_a_window_and_said_once() {
  // console.warn from a module goes to the console API storage, not nsIConsoleService.
  const lines = [];
  const storage = Cc["@mozilla.org/consoleAPI-storage;1"].getService(Ci.nsIConsoleAPIStorage);
  const onLog = (/** @type {any} */ m) => lines.push((m.arguments ?? []).map(String).join(" "));
  storage.addLogEventListener(onLog, Services.scriptSecurityManager.getSystemPrincipal());
  const f = await start({ mode: "nameless" });
  await SimpleTest.promiseFocus(window);
  const opened = BrowserTestUtils.waitForNewWindow();
  prefix("P", { shiftKey: true });
  const priv = await opened;
  await until(() => Services.focus.activeWindow === priv, "the private window, as a window");
  await until(
    () => lines.some((l) => l.includes("vimma: private: Hyprland did not name")),
    "the give-up is logged (decision 7)",
  );
  await until(
    () => /window not named/.test(PrivateSwap.status),
    "and about:vimma says why the swap did not run",
  );
  await SimpleTest.promiseFocus(priv);
  prefix("P", { shiftKey: true }, priv);
  await until(() => Services.focus.activeWindow === window, "back as a window");
  await SimpleTest.promiseFocus(window);
  const again = Date.now();
  prefix("P", { shiftKey: true });
  await until(() => Services.focus.activeWindow === priv, "and there again");
  // Hyprland has not named a window this session: later switches do not wait NAME_MS again.
  Assert.less(Date.now() - again, NAME_MS, "the next switch is not held for NAME_MS");
  await wait(700); // past REPLY_MS: a late second nonce would have timed out by now
  storage.removeLogEventListener(onLog);
  Assert.equal(
    lines.filter((l) => l.includes("vimma: private: Hyprland did not name")).length,
    1,
    "one console line a session",
  );
  Assert.deepEqual(
    f.received.filter((r) => r.startsWith("[[BATCH]]")),
    [],
    "nothing is moved",
  );
  Assert.ok(!lines.some((l) => l.includes(EVENT_TITLE)), "no event title in the console");
});

// A reset while Hyprland has not named a window yet (the next task's start(), here at once):
// the naming in flight must end, give the window its title back, and not stand in for the next
// one, or every later swap waits forever for an address (seen on #186's CI, where a slow run
// ended nothing_is_sent_before_the_config_says_where mid-naming).
add_task(async function a_reset_while_a_window_is_being_named_names_it_afresh() {
  await start({ mode: "nameless" }, undefined, { configured: false });
  PrivateSwap.configure("swap");
  const nonce = /^vimma-[0-9a-f]{32}$/;
  await until(() => nonce.test(document.title), "the normal window carries its nonce title");
  await start();
  await until(() => !nonce.test(document.title), "the window gets its own title back");
  const priv = await enter();
  Assert.ok(inSlot(priv) && parked(window), "both windows are named afresh and the swap runs");
});
