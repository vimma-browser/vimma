/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The control socket's server, protocols 1 and 2 (specs: docs/specs/m0-control-server.md,
// docs/specs/m0-control-protocol-and-vimma-ctl.md; ADR-007; protocol 2's roles:
// docs/specs/vimma-mcp.md, ADR-019). One per app, not per window. JSON lines over TCP on
// 127.0.0.1, a token from <profile>/vimma-control.json (0600) required before any command.
//
// Two switches, two roles (vimma-mcp decision 3): `vimma.control.enabled` serves `full` (v1's
// commands: keys, state, open, theme), `[mcp] enabled` / `:mcp on` serves `agent` (the agent
// commands only, confined to the agent workspace and confirmed, ctl/agent-commands.mjs). Either
// starts the server; it stops when both are off. A connection's role is fixed by its hello, and
// every command is checked against it.
//
// A third way in, for an agent CLI the built-in agent runs (docs/specs/builtin-agent-cli.md C1,
// C3): a one-time ticket bound to one conversation's gate connection (`builtin:<n>`). While a
// ticket is live the server listens even with both switches off, and then takes nothing but a
// ticket; no discovery file names it. A ticket's connection acts as the conversation, on its
// tabs and under its grant, never as an MCP agent of its own.

import {
  AGENT_COMMANDS,
  CONTROL_COMMANDS,
  CONTROL_PROTOCOL,
  LATEST_PROTOCOL,
  LineFramer,
  PROTOCOLS,
  ROLES,
  MAX_LINE_LENGTH,
  RESERVED_COMMANDS,
  tokensEqual,
  validateMessage,
  CHALLENGE_CONTEXT,
  TICKET_CONTEXT,
} from "../core/control.mjs";
import { isCtlVersion } from "../core/ctl-version.mjs";
import { parseKey } from "../core/keys.mjs";
import { VimmaHost } from "../host/VimmaHost.sys.mjs";
import { PaneViews } from "../split/PaneView.mjs";
import { ThemeHost } from "../ui/theme-host.mjs";
import { WorkspaceStore } from "../workspaces/WorkspaceStore.sys.mjs";
import { MCP_CHANGED_TOPIC, MCP_ENABLED_PREF, McpHost } from "../host/mcp-ops.mjs";
import { AgentGate } from "./AgentGate.sys.mjs";
import { AgentError, forgetAgentConnection, runAgentCommand } from "./agent-commands.mjs";

/** @import { Chord } from "../core/keys.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const ENABLED_PREF = "vimma.control.enabled";
/** Test-only overrides of the spec's 5 s and 60 s. */
const HELLO_TIMEOUT_PREF = "vimma.control.helloTimeoutMs";
const IDLE_TIMEOUT_PREF = "vimma.control.idleTimeoutMs";
const HELLO_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 60000;
/** Authenticated connections; the next hello is told busy. */
const MAX_CONNECTIONS = 8;
/**
 * Of those, agent connections (security.md S5): agents never take every slot, so vimma-ctl
 * still gets in.
 */
const MAX_AGENT_CONNECTIONS = 4;
/** An agent connection's requests waiting or running at once; beyond, `busy`. */
const MAX_AGENT_INFLIGHT = 4;
/**
 * Connections still waiting for their hello. Anyone local can open those, so they are capped
 * apart from the authenticated ones and a new one evicts the oldest: a flood of idle
 * connections cannot lock out a client with the token (security.md S5).
 */
const MAX_WAITING = 2;
/** Unsent output beyond this means the client is not reading: close it. */
const MAX_PENDING_OUT = 4 * 1024 * 1024;
/** Refused connections allowed to linger for their answer at once. */
const MAX_CLOSING = 16;
const BACKLOG = 16;
const DISCOVERY_FILE = "vimma-control.json";
/** After an error that ends the connection: how long to wait for the client to close first. */
const DRAIN_MS = 1000;

/** @typedef {{ code: string, message: string, reason?: string }} ProtocolError */
/** @typedef {"agent" | "full"} Role */

/** What a hello for a role that is off is told: the switch that turns it on. */
const ROLE_OFF = {
  agent: "MCP is off in Vimma: run :mcp on (or set [mcp] enabled = true)",
  full: "the control socket is off: set the pref vimma.control.enabled to true",
};

/** The roles the switches serve now, in ROLES order. @returns {Role[]} */
function enabledRoles() {
  const on = {
    agent: McpHost.state.enabled,
    full: Services.prefs.getBoolPref(ENABLED_PREF, false),
  };
  return /** @type {Role[]} */ (ROLES.filter((r) => on[/** @type {Role} */ (r)]));
}

let connectionIds = 0;

/**
 * A one-time ticket (docs/specs/builtin-agent-cli.md C3): `conn` and `state` are its
 * conversation's gate connection; `label` names the CLI in a notice; `live` is the connection
 * using it; `used` is set once one has; `session` is that connection's `vimma-ctl mcp` session
 * id, which only a reconnect of the same process knows.
 * @typedef {{ ticket: string, id: string, conn: string,
 *   state: import("./agent-commands.mjs").AgentConn, label: string,
 *   live: Connection | null, used: boolean, session: string | null }} Ticket
 */
/** Live tickets, by id (HMAC-SHA256(ticket, TICKET_CONTEXT)). @type {Map<string, Ticket>} */
const tickets = new Map();
/**
 * Request ids that a ticket connection's commands run under in its conversation's state:
 * negative, so they never meet the ids the conversation's own model loop uses (AgentChat).
 */
let ticketRids = 0;

/**
 * A failure the client caused (or `failed`): answered with `code`, not logged as a bug.
 */
class ControlError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Bytes as a hex string. @param {Uint8Array} bytes */
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * HMAC-SHA256(key, message) over their UTF-8 bytes, as lowercase hex (protocol v1's `proof`).
 * @param {string} key @param {string} message
 */
async function hmacHex(key, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message))));
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The browser window keys and state are for: the most recently focused one. */
function topWindow() {
  const win =
    lazy.BrowserWindowTracker.getTopWindow({ allowPopups: false }) ??
    Services.wm.getMostRecentWindow("navigator:browser");
  if (!win) throw new ControlError("failed", "no browser window");
  return win;
}

// ---------------------------------------------------------------------------------------------
// Key injection: chords become real key presses through a TextInputProcessor, so the host's
// keydown listener, Firefox's shortcuts and the page see what a keyboard would have produced.

/** vimma-core's named keys → DOM KeyboardEvent key and code. */
/** @type {Record<string, [string, string]>} */
const NAMED_DOM_KEYS = {
  esc: ["Escape", "Escape"],
  enter: ["Enter", "Enter"],
  tab: ["Tab", "Tab"],
  space: [" ", "Space"],
  backspace: ["Backspace", "Backspace"],
  delete: ["Delete", "Delete"],
  up: ["ArrowUp", "ArrowUp"],
  down: ["ArrowDown", "ArrowDown"],
  left: ["ArrowLeft", "ArrowLeft"],
  right: ["ArrowRight", "ArrowRight"],
  home: ["Home", "Home"],
  end: ["End", "End"],
  pageup: ["PageUp", "PageUp"],
  pagedown: ["PageDown", "PageDown"],
  insert: ["Insert", "Insert"],
};
for (let i = 1; i <= 12; i++) NAMED_DOM_KEYS[`f${i}`] = [`F${i}`, `F${i}`];

/** US-layout keyCodes for printable characters that are not letters or digits. */
/** @type {Record<string, number>} */
const PUNCTUATION_KEYCODES = {
  ";": 59,
  ":": 59,
  "=": 61,
  "+": 61,
  ",": 188,
  "<": 188,
  "-": 173,
  _: 173,
  ".": 190,
  ">": 190,
  "/": 191,
  "?": 191,
  "`": 192,
  "~": 192,
  "[": 219,
  "{": 219,
  "\\": 220,
  "|": 220,
  "]": 221,
  "}": 221,
  "'": 222,
  '"': 222,
  "!": 49,
  "@": 50,
  "#": 51,
  $: 52,
  "%": 53,
  "^": 54,
  "&": 55,
  "*": 56,
  "(": 57,
  ")": 48,
};

/** @type {Array<[keyof Chord, string, string]>} chord flag, DOM key, DOM code */
const MODIFIER_KEYS = [
  ["ctrl", "Control", "ControlLeft"],
  ["alt", "Alt", "AltLeft"],
  ["shift", "Shift", "ShiftLeft"],
  ["meta", "Meta", "MetaLeft"],
];

/**
 * The KeyboardEvent init for a chord's key (modifiers are pressed separately).
 * @param {Chord} chord
 */
function keyInit(chord) {
  const named = NAMED_DOM_KEYS[chord.key];
  if (named) {
    const [key, code] = named;
    return key === " " ? { key, code, keyCode: 32 } : { key, code };
  }
  const ch = chord.key;
  if (/^[a-z]$/.test(ch)) {
    return {
      key: chord.shift ? ch.toUpperCase() : ch,
      code: `Key${ch.toUpperCase()}`,
      keyCode: ch.toUpperCase().charCodeAt(0),
    };
  }
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0) };
  return { key: ch, keyCode: PUNCTUATION_KEYCODES[ch] ?? 0 };
}

/**
 * Press and release each chord in `win`, holding its modifiers like a person would.
 * @param {Window} win
 * @param {Chord[]} chords
 */
function pressChords(win, chords) {
  const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
  if (!tip.beginInputTransaction(win, () => true)) {
    throw new ControlError("failed", "another input method owns the window's keyboard input");
  }
  const KeyboardEvent = /** @type {any} */ (win).KeyboardEvent;
  for (const chord of chords) {
    const held = MODIFIER_KEYS.filter(([flag]) => chord[flag]);
    for (const [, key, code] of held) tip.keydown(new KeyboardEvent("", { key, code }));
    const event = new KeyboardEvent("", keyInit(chord));
    tip.keydown(event);
    tip.keyup(event);
    for (const [, key, code] of held.reverse()) tip.keyup(new KeyboardEvent("", { key, code }));
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

/**
 * `state.panes`: the window's pane tree with state's tab ids, or null with one pane (protocol
 * spec, "state"). The tree names tabs by panel; a leaf also gets its place in `tabs` (-1 when
 * its tab is not visible), so a scenario can match a layout without knowing the ids.
 * @param {any} win
 * @param {any[]} visible gBrowser.visibleTabs
 */
function paneState(win, visible) {
  const panes = PaneViews.get(win)?.panes;
  if (!panes) return null;
  const tabOf = (/** @type {string} */ panel) =>
    win.gBrowser.tabs.find((/** @type {any} */ t) => t.linkedPanel === panel);
  const idOf = (/** @type {any} */ tab) => (tab ? String(tab.linkedBrowser.browserId) : null);
  /** @param {any} n @returns {object} */
  const node = (n) => {
    if (n.type === "leaf") {
      const tab = tabOf(n.tab);
      return { tab: idOf(tab), index: visible.indexOf(tab) };
    }
    return { axis: n.axis, ratios: [...n.ratios], children: n.children.map(node) };
  };
  /** @param {any} n @returns {any} */
  const focused = (n) =>
    n.type === "leaf" ? (n.pane === panes.focus ? n : null) : n.children.map(focused).find(Boolean);
  return {
    focus: idOf(tabOf(focused(panes.root)?.tab)),
    zoomed: panes.zoom !== null,
    // docs/specs/side-panel-unsplit.md decision 28: a split kept as a hidden view.
    hidden: panes.hidden === true,
    root: node(panes.root),
  };
}

/**
 * `state.tabs[].loading`: the tab's page is loading or still to load. It names no page, so a
 * private window keeps it, where it is the only sign of a loaded page (#567). A new window is
 * listed before it starts to load its first page, which it does in delayed startup
 * (browser-init.js): until then its tabs are on their initial about:blank and not busy yet.
 * @param {any} win @param {any} tab
 */
function tabLoading(win, tab) {
  if (tab.hasAttribute("busy")) return true;
  // A lazy (restored or unloaded) tab loads nothing, and reading its browser's webProgress
  // would insert the browser and start a content process: `state` stays read-only (S9).
  if (!tab.linkedPanel || tab.hasAttribute("pending")) return false;
  const browser = tab.linkedBrowser;
  if (browser.webProgress?.isLoadingDocument) return true;
  if (win.gBrowserInit?.delayedStartupFinished === true) return false;
  return browser.browsingContext?.currentWindowGlobal?.isInitialDocument ?? true;
}

/** @type {Record<string, (args: any) => object>} */
const COMMANDS = {
  "send-keys"({ keys }) {
    // The validator has already parsed every chord; parse again for the values.
    const chords = keys.split(/\s+/).filter(Boolean).map(parseKey);
    pressChords(topWindow(), chords);
    return { sent: chords.length };
  },

  state() {
    const win = /** @type {any} */ (topWindow());
    const host = VimmaHost.status(win);
    const { gBrowser } = win;
    const visible = gBrowser.visibleTabs;
    // docs/specs/private-workspace.md decision 8d: a private window's pages stay unnamed; the
    // ids and the pane structure are kept, so scripts can still drive it.
    const hidden = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    return {
      mode: host.mode,
      pending: host.pending.length ? host.pending.join(" ") : null,
      workspace: host.workspace?.name ?? null,
      ...(hidden ? { private: true } : {}),
      tabs: visible.map((/** @type {any} */ tab, /** @type {number} */ index) => ({
        id: String(tab.linkedBrowser.browserId),
        index,
        url: hidden ? null : tab.linkedBrowser.currentURI.spec,
        title: hidden ? null : tab.label,
        selected: tab.selected,
        pinned: tab.pinned,
        loading: tabLoading(win, tab),
      })),
      panes: paneState(win, visible),
    };
  },

  open({ url, where = "tab" }) {
    let uri;
    try {
      uri = Services.io.newURI(url);
    } catch {
      throw new ControlError("invalid-args", "url is not a valid URL");
    }
    // The validator checked the text; check what the URL parser made of it too.
    if (!["http", "https", "file", "about"].includes(uri.scheme)) {
      throw new ControlError("invalid-args", "url scheme must be http, https, file or about");
    }
    const win = /** @type {any} */ (topWindow());
    // The system principal, as BrowserContentHandler uses for `vimma <url>`: the token holder
    // is the user, and javascript: and data: are refused above, so no script runs in a page's
    // context. Not through browserDOMWindow.openURI(OPEN_EXTERNAL) like the command line:
    // that turns an external about:blank into the new-tab page with the URL bar focused, and
    // lets the external-link prefs pick another window; `where` is explicit here.
    const { gBrowser } = win;
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    // Never in the agent workspace (docs/specs/vimma-mcp.md, decision 42): agents read its
    // pages, and the URL may carry a login. "current" on an agent tab becomes a new tab.
    const current =
      where === "current" && !WorkspaceStore.isAgentContainer(gBrowser.selectedTab.userContextId);
    const tab = current
      ? gBrowser.selectedTab
      : gBrowser.addTab(uri.spec, {
          triggeringPrincipal: principal,
          inBackground: false,
          userContextId: WorkspaceStore.nonAgentUserContextId(win) ?? undefined,
        });
    if (current) {
      tab.linkedBrowser.loadURI(uri, { triggeringPrincipal: principal });
    }
    return { tab: String(tab.linkedBrowser.browserId) };
  },

  // Omarchy's theme-set hook (spec m5-omarchy-theme). No args: the browser reads only the
  // theme directory its own prefs name, with the same validation as the poll.
  "reload-theme"() {
    return ThemeHost.reload();
  },
};

// ---------------------------------------------------------------------------------------------
// Connections

class Connection {
  /**
   * @param {Server} server
   * @param {any} transport nsISocketTransport
   */
  constructor(server, transport) {
    this.server = server;
    this.transport = transport;
    this.input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
    this.binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    this.binary.setInputStream(this.input);
    this.output = transport.openOutputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
    /** Bytes in, lines out (core control.mjs; fuzzed in its tests). */
    this.framer = new LineFramer();
    this.authenticated = false;
    /** Which handshake line comes next. @type {"hello" | "auth"} */
    this.stage = "hello";
    this.closed = false;
    /** Binary string waiting for the socket to accept it. */
    this.pendingOut = "";
    this.closeAfterWrite = false;
    /** The server is stopping: finish the command in flight, answer it, then close. */
    this.stopping = false;
    /** After an error that ends the connection: input is read and dropped until the close. */
    this.draining = false;
    this.running = false;
    /** Requests run in order: each waits for the one before. */
    this.queue = Promise.resolve();
    this.timer = null;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    /** Its key in AgentGate. */
    this.id = ++connectionIds;
    /** Fixed by the hello: protocol 1 is `full`. @type {Role | null} */
    this.role = null;
    this.protocol = CONTROL_PROTOCOL;
    /** An agent connection's labels, once its agent-hello is in. @type {{ agent?: any }} */
    this.agentState = {};
    /** Agent requests waiting for an answer or running: they do not wait for each other. */
    this.inflight = 0;
    /**
     * Withdraws a full-control question still waiting (decision 29 C).
     * @type {(() => void) | null}
     */
    this.cancelAsk = null;
    /** The ticket its hello named: it then acts as that ticket's conversation. @type {Ticket | null} */
    this.ticket = null;
    /** A ticket's connection after one before it: its agent-hello must carry their session. */
    this.reconnect = false;
    /** A ticket's connection has said its agent-hello. */
    this.helloed = false;
    /** A ticket's requests running: the client's id → the id it runs under. @type {Map<number, number>} */
    this.rids = new Map();
  }

  /** The idle limit closes a connection, unless an agent request of it is waiting or running. */
  armIdle() {
    this.arm(Services.prefs.getIntPref(IDLE_TIMEOUT_PREF, IDLE_TIMEOUT_MS), () => {
      if (this.inflight > 0) this.armIdle();
      else this.close();
    });
  }

  start() {
    this.arm(Services.prefs.getIntPref(HELLO_TIMEOUT_PREF, HELLO_TIMEOUT_MS), () =>
      this.fail(null, "bad-request", "no hello within the deadline"),
    );
    this.waitForInput();
  }

  /** @param {number} ms @param {() => void} onTimeout */
  arm(ms, onTimeout) {
    if (this.timer !== null) lazy.clearTimeout(this.timer);
    this.timer = lazy.setTimeout(() => {
      this.timer = null;
      if (!this.closed) onTimeout();
    }, ms);
  }

  waitForInput() {
    if (!this.closed) this.input.asyncWait(this, 0, 0, Services.tm.mainThread);
  }

  /** nsIInputStreamCallback */
  onInputStreamReady() {
    if (this.closed) return;
    let bytes;
    try {
      // available() is 0 both at EOF and before the transport is attached; a read tells them
      // apart: 0 bytes is EOF, "would block" means wait.
      const size = Math.min(Math.max(this.input.available(), 1), MAX_LINE_LENGTH + 2);
      const buffer = new ArrayBuffer(size);
      bytes = new Uint8Array(buffer, 0, this.binary.readArrayBuffer(size, buffer));
    } catch (e) {
      if (/** @type {any} */ (e).result === Cr.NS_BASE_STREAM_WOULD_BLOCK) this.waitForInput();
      else this.close(); // the peer closed or reset
      return;
    }
    if (bytes.length === 0) {
      this.close();
      return;
    }
    if (!this.draining) this.receive(bytes);
    this.waitForInput();
  }

  /** @param {Uint8Array} bytes */
  receive(bytes) {
    for (const line of this.framer.push(bytes)) {
      // A line that ended the connection drops the rest.
      if (this.closed || this.draining) return;
      this.onLine(line);
    }
    if (this.framer.overflow && !this.closed && !this.draining) {
      this.fail(null, "bad-request", `line longer than ${MAX_LINE_LENGTH} bytes`);
    }
  }

  /** @param {Uint8Array} bytes one line without its newline, at most MAX_LINE_LENGTH bytes */
  onLine(bytes) {
    /** @type {unknown} */
    let message;
    try {
      message = JSON.parse(this.decoder.decode(bytes));
    } catch {
      message = undefined;
    }
    if (this.stopping) return;
    if (!this.authenticated) {
      // In order, like requests: the challenge's HMAC is computed asynchronously.
      this.queue = this.queue.then(() => this.handshake(message));
      return;
    }
    this.armIdle();
    // An agent's requests wait for the user, each on its own (vimma-mcp decision 17): they
    // run side by side and are answered by id. A full connection's run in order.
    if (this.role === "agent") this.request(message);
    else this.queue = this.queue.then(() => this.request(message));
  }

  /**
   * hello {nonce} → challenge {proof} → auth {token} → welcome (spec
   * m0-control-protocol-and-vimma-ctl). The server proves it knows the token before the client
   * sends it, so a squatter on a stale port never sees it. One deadline (`start`) covers the
   * whole handshake; anything out of order ends the connection.
   * @param {unknown} m
   */
  async handshake(m) {
    if (this.closed || this.draining) return;
    if (this.stage === "hello") {
      if (!isObject(m) || m.type !== "hello") {
        this.fail(null, "bad-request", "the first line must be a hello");
        return;
      }
      if (Number.isInteger(m.protocol) && !PROTOCOLS.includes(/** @type {number} */ (m.protocol))) {
        this.fail(
          null,
          "unsupported-protocol",
          `this server speaks protocols ${PROTOCOLS.join(" and ")}`,
        );
        return;
      }
      const v = validateMessage(m, { kind: "hello" });
      if (!v.valid) {
        this.fail(null, "bad-request", v.errors.join("; "));
        return;
      }
      // An agent CLI's ticket, named by its id: served whatever the switches say, since only
      // Vimma handed it out, for one run (builtin-agent-cli C3). The validator allowed it with
      // protocol 2 and the agent role only.
      if (typeof m.ticket === "string") {
        const ticket = tickets.get(m.ticket);
        if (!ticket) {
          this.fail(null, "unauthorized", "no such ticket: the task it was made for has ended");
          return;
        }
        this.ticket = ticket;
        this.role = "agent";
        this.protocol = 2;
        this.stage = "auth";
        // S4 with the ticket as the key: the client sends the ticket only after this proof.
        const proof = await hmacHex(ticket.ticket, CHALLENGE_CONTEXT + m.nonce);
        this.write({ type: "challenge", protocol: this.protocol, proof });
        return;
      }
      // Protocol 1 is the full role (vimma-mcp decision 2).
      const role = /** @type {Role} */ (m.protocol === 1 ? "full" : m.role);
      if (!this.server.roles.includes(role)) {
        this.fail(null, "role-off", ROLE_OFF[role]);
        return;
      }
      this.role = role;
      this.protocol = /** @type {number} */ (m.protocol);
      this.stage = "auth";
      // Domain-separated, so this answer to an unauthenticated nonce is good for nothing else.
      const proof = await hmacHex(this.server.token, CHALLENGE_CONTEXT + m.nonce);
      this.write({ type: "challenge", protocol: this.protocol, proof });
      return;
    }
    if (!isObject(m) || m.type !== "auth") {
      this.fail(null, "bad-request", "expected auth after the challenge");
      return;
    }
    if (this.ticket) {
      this.ticketAuth(m);
      return;
    }
    // Constant time in where the tokens differ; a malformed token simply does not match.
    if (typeof m.token !== "string" || !tokensEqual(m.token, this.server.token)) {
      this.fail(null, "unauthorized", "bad token");
      return;
    }
    const v = validateMessage(m, { kind: "auth" });
    if (!v.valid) {
      this.fail(null, "bad-request", v.errors.join("; "));
      return;
    }
    const { server: srv } = this;
    // The role's switch may have gone off during the handshake.
    if (!srv.roles.includes(/** @type {Role} */ (this.role))) {
      this.fail(null, "role-off", ROLE_OFF[/** @type {Role} */ (this.role)]);
      return;
    }
    srv.waiting.delete(this);
    if (srv.connections.size >= MAX_CONNECTIONS) {
      srv.refuse(this, "busy", `${srv.connections.size} connections open`);
      return;
    }
    // A ticket's connection is not counted: one per running CLI task, so MCP agents cannot
    // take the place a task Vimma started needs.
    const agents = [...srv.connections].filter((c) => c.role === "agent" && !c.ticket).length;
    if (this.role === "agent" && agents >= MAX_AGENT_CONNECTIONS) {
      srv.refuse(this, "busy", `${agents} agent connections open`);
      return;
    }
    srv.connections.add(this);
    // While MCP is on, a new full connection asks first (vimma-mcp decision 29 C): an agent with
    // a shell can read the token. The question waits as long as the agent role's do.
    if (this.role === "full" && McpHost.state.enabled) {
      if (this.timer !== null) lazy.clearTimeout(this.timer);
      this.timer = null;
      // The code the client printed, shown in the question (security.md S13).
      const code = typeof m.code === "string" ? m.code : null;
      const outcome = await AgentGate.askFull(code, (cancel) => (this.cancelAsk = cancel));
      this.cancelAsk = null;
      if (this.closed) return;
      if (!outcome.allow) {
        const message =
          outcome.reason === "timeout"
            ? "no answer in Vimma in time: full control refused"
            : outcome.reason === "busy"
              ? "another full-control question is waiting in Vimma"
              : "the user refused full control in Vimma";
        this.fail(null, "denied", message, outcome.reason);
        return;
      }
      // The switches may have changed while the user was asked.
      if (!srv.roles.includes("full")) {
        this.fail(null, "role-off", ROLE_OFF.full);
        return;
      }
    }
    this.authenticated = true;
    this.armIdle();
    this.write({
      type: "welcome",
      protocol: this.protocol,
      app: "Vimma",
      version: lazy.AppConstants.MOZ_APP_VERSION_DISPLAY,
      ...(this.protocol >= 2 ? { role: this.role } : {}),
    });
  }

  /**
   * The auth of a ticket's connection: the ticket itself, once. A second connection while one
   * lives, or after one that kept no session id, is refused with a notice; a later one is let
   * in to prove with its agent-hello that it is the same `vimma-ctl mcp` reconnecting.
   * @param {Record<string, unknown>} m
   */
  ticketAuth(m) {
    const ticket = /** @type {Ticket} */ (this.ticket);
    if (typeof m.ticket !== "string" || !tokensEqual(m.ticket, ticket.ticket)) {
      this.fail(null, "unauthorized", "bad ticket");
      return;
    }
    const v = validateMessage(m, { kind: "auth" });
    if (!v.valid) {
      this.fail(null, "bad-request", v.errors.join("; "));
      return;
    }
    // Revoked during the handshake: the task ended.
    if (tickets.get(ticket.id) !== ticket) {
      this.fail(null, "unauthorized", "no such ticket: the task it was made for has ended");
      return;
    }
    if ((ticket.live && !ticket.live.closed) || (ticket.used && ticket.session === null)) {
      this.refuseTicket(null);
      return;
    }
    const { server: srv } = this;
    srv.waiting.delete(this);
    if (srv.connections.size >= MAX_CONNECTIONS) {
      srv.refuse(this, "busy", `${srv.connections.size} connections open`);
      return;
    }
    this.reconnect = ticket.used;
    ticket.used = true;
    ticket.live = this;
    srv.connections.add(this);
    this.authenticated = true;
    this.armIdle();
    this.write({
      type: "welcome",
      protocol: this.protocol,
      app: "Vimma",
      version: lazy.AppConstants.MOZ_APP_VERSION_DISPLAY,
      role: "agent",
    });
  }

  /**
   * Another program has the ticket (any process of the user can read the CLI's environment):
   * refused, and the user told, never with the ticket's value.
   * @param {unknown} id
   */
  refuseTicket(id) {
    const { label } = /** @type {Ticket} */ (this.ticket);
    AgentGate.notify(`a second program used ${label}'s ticket and was refused`);
    this.fail(id, "unauthorized", "this ticket is already in use");
  }

  /**
   * A command of a ticket's connection, run as its conversation (builtin-agent-cli C1): on the
   * conversation's connection and state, so its tabs, grant, rates and budget are the
   * conversation's. Its agent-hello labels nothing: the conversation keeps its own label.
   * @param {string} command @param {any} args @param {number} id
   */
  async ticketCommand(command, args, id) {
    const ticket = /** @type {Ticket} */ (this.ticket);
    if (command === "agent-hello") {
      if (this.helloed) throw new AgentError("bad-request", "agent-hello was already sent");
      this.helloed = true;
      ticket.session ??= typeof args.session === "string" ? args.session : null;
      const agent = WorkspaceStore.agent;
      return { workspace: agent?.name ?? WorkspaceStore.agentName ?? "agent", exists: !!agent };
    }
    if (!this.helloed) {
      throw new AgentError("bad-request", "agent-hello must be the connection's first command");
    }
    if (command === "agent-cancel") {
      const rid = this.rids.get(args.id);
      const cancel = rid === undefined ? undefined : ticket.state.cancels?.get(rid);
      if (!cancel) return { cancelled: false };
      ticket.state.cancels?.delete(/** @type {number} */ (rid));
      cancel();
      return { cancelled: true };
    }
    // One request per id at a time: a second would take the first's entry, leaving its
    // question beyond agent-cancel and the withdrawal when the connection drops.
    if (this.rids.has(id)) throw new AgentError("bad-request", `request id ${id} is in flight`);
    const rid = --ticketRids;
    this.rids.set(id, rid);
    try {
      return await runAgentCommand(ticket.conn, ticket.state, command, args, rid);
    } finally {
      this.rids.delete(id);
    }
  }

  /** @param {unknown} m */
  async request(m) {
    if (this.closed) return;
    if (!isObject(m)) {
      this.respond(null, { error: { code: "bad-request", message: "not a JSON object" } });
      return;
    }
    const id = Number.isInteger(m.id) && /** @type {number} */ (m.id) >= 1 ? m.id : null;
    const extra = Object.keys(m).filter((k) => !["type", "id", "command", "args"].includes(k));
    if (m.type !== "request" || id === null || extra.length || !isObject(m.args)) {
      const v = validateMessage(m, { kind: "request" });
      this.respond(id, { error: { code: "bad-request", message: v.errors.join("; ") } });
      return;
    }
    const command = /** @type {string} */ (m.command);
    // Only the commands of the connection's role exist for it (security.md S7, S12): an agent
    // connection never reaches send-keys, state or open, and a full one no agent command.
    const agent = this.role === "agent";
    if (agent !== AGENT_COMMANDS.includes(command)) {
      this.respond(id, {
        error: {
          code: "unknown-command",
          message:
            typeof command === "string" ? `unknown command ${command}` : "command must be a string",
        },
      });
      return;
    }
    if (agent) {
      await this.agentRequest(id, m);
      return;
    }
    if (RESERVED_COMMANDS.includes(command)) {
      this.respond(id, { error: { code: "not-implemented", message: `${command} is reserved` } });
      return;
    }
    if (!CONTROL_COMMANDS.includes(command)) {
      this.respond(id, {
        error: {
          code: "unknown-command",
          // Not String(command): a parsed object can carry a toString that is not a function.
          message:
            typeof command === "string" ? `unknown command ${command}` : "command must be a string",
        },
      });
      return;
    }
    const v = validateMessage(m, { kind: "request" });
    if (!v.valid) {
      this.respond(id, { error: { code: "invalid-args", message: v.errors.join("; ") } });
      return;
    }
    this.running = true;
    try {
      const result = await COMMANDS[command]?.(m.args);
      this.respond(id, { result });
    } catch (e) {
      if (e instanceof ControlError) {
        this.respond(id, { error: { code: e.code, message: e.message } });
      } else {
        console.error("vimma control:", command, e);
        this.respond(id, { error: { code: "internal", message: String(e) } });
      }
    } finally {
      this.running = false;
    }
    // `send-keys ctrl+q` quits the app while it runs: still answer it before closing.
    if (this.stopping) this.stop();
  }

  /**
   * An agent command: validated, then run; it may wait for the user (AgentGate) while the
   * connection's other requests go on.
   * @param {unknown} id @param {Record<string, unknown>} m
   */
  async agentRequest(id, m) {
    const v = validateMessage(m, { kind: "request" });
    if (!v.valid) {
      this.respond(id, { error: { code: "invalid-args", message: v.errors.join("; ") } });
      return;
    }
    const command = /** @type {string} */ (m.command);
    const args = /** @type {any} */ (m.args);
    // A ticket's later connection must be the same vimma-ctl process: its session id says so.
    if (this.ticket && this.reconnect && !this.helloed) {
      const session = typeof args.session === "string" ? args.session : "";
      if (command !== "agent-hello" || !tokensEqual(session, this.ticket.session ?? "")) {
        this.refuseTicket(id);
        return;
      }
    }
    // A withdrawal never waits and must reach a connection whose requests all wait.
    const counted = command !== "agent-cancel";
    if (counted && this.inflight >= MAX_AGENT_INFLIGHT) {
      const message = `${this.inflight} requests of this agent are already waiting or running`;
      this.respond(id, { error: { code: "denied", message, reason: "busy" } });
      return;
    }
    if (counted) this.inflight++;
    try {
      const rid = /** @type {number} */ (id);
      const result = this.ticket
        ? await this.ticketCommand(command, args, rid)
        : await runAgentCommand(this.id, this.agentState, command, args, rid);
      this.respond(id, { result });
    } catch (e) {
      if (e instanceof AgentError) {
        const error = {
          code: e.code,
          message: e.message,
          ...(e.reason ? { reason: e.reason } : {}),
          ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
        };
        this.respond(id, { error });
      } else {
        console.error("vimma control (agent):", command, e);
        this.respond(id, { error: { code: "internal", message: "internal error" } });
      }
    } finally {
      if (counted) this.inflight--;
    }
  }

  /** Close now, or after answering the command in flight. */
  stop() {
    this.stopping = true;
    if (this.running) return;
    this.closeAfterWrite = true;
    this.flush();
  }

  /**
   * @param {unknown} id
   * @param {{ result?: object, error?: ProtocolError }} body
   */
  respond(id, body) {
    this.write({ type: "response", id, ok: !body.error, ...body });
  }

  /**
   * Answer with an error (`id`), then close: once the client has closed its end, or after
   * DRAIN_MS. Whatever the client still sends meanwhile is read and dropped. Closing at once
   * loses the answer now and then: with unread input the kernel resets the connection (RST),
   * and a client may see the close before it has read the line.
   * @param {unknown} id @param {string} code @param {string} message
   * @param {string} [reason]  a denial's (`denied` needs one)
   */
  fail(id, code, message, reason) {
    this.respond(id, { error: { code, message, ...(reason ? { reason } : {}) } });
    this.draining = true;
    this.arm(DRAIN_MS, () => this.stop());
    this.waitForInput();
  }

  /** @param {object} message */
  write(message) {
    if (this.closed || this.closeAfterWrite) return;
    const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n");
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    this.pendingOut += s;
    if (this.pendingOut.length > MAX_PENDING_OUT) {
      this.close(); // the client stopped reading
      return;
    }
    this.flush();
  }

  flush() {
    while (!this.closed && this.pendingOut.length) {
      let n;
      try {
        n = this.output.write(this.pendingOut, this.pendingOut.length);
      } catch (e) {
        if (/** @type {any} */ (e).result === Cr.NS_BASE_STREAM_WOULD_BLOCK) {
          this.output.asyncWait(
            { onOutputStreamReady: () => this.flush() },
            0,
            0,
            Services.tm.mainThread,
          );
          return;
        }
        this.close();
        return;
      }
      this.pendingOut = this.pendingOut.slice(n);
    }
    if (this.closeAfterWrite) this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cancelAsk?.();
    this.cancelAsk = null;
    // A ticket's connection is not its conversation: the questions it waits on go, and the
    // conversation, its grant and its tabs stay, so the same vimma-ctl can reconnect.
    if (this.ticket) {
      for (const rid of this.rids.values()) this.ticket.state.cancels?.get(rid)?.();
      this.rids.clear();
      if (this.ticket.live === this) this.ticket.live = null;
    } else if (this.role === "agent") {
      // Its waiting questions go, and its grants end (vimma-mcp decision 22).
      AgentGate.disconnect(this.id);
      forgetAgentConnection(this.id);
    }
    if (this.timer !== null) lazy.clearTimeout(this.timer);
    this.timer = null;
    this.input.close();
    this.output.close();
    this.transport.close(Cr.NS_OK);
    this.server.connections.delete(this);
    this.server.waiting.delete(this);
    this.server.closing.delete(this);
  }
}

// ---------------------------------------------------------------------------------------------
// Server

class Server {
  /** @param {string} token @param {Role[]} roles */
  constructor(token, roles) {
    this.token = token;
    /** The roles served now; a hello for any other is told `role-off`. */
    this.roles = roles;
    /** Authenticated. @type {Set<Connection>} */
    this.connections = new Set();
    /** Waiting for a hello, oldest first. @type {Set<Connection>} */
    this.waiting = new Set();
    /** Refused (busy) connections waiting to close. @type {Set<Connection>} */
    this.closing = new Set();
    // Loopback only: Init(…, true, …) binds 127.0.0.1 (PR_IpAddrLoopback, AF_INET;
    // netwerk/base/nsServerSocket.cpp InitSpecialConnection). Port -1: the OS picks one.
    this.socket = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
    this.socket.init(-1, true, BACKLOG);
    this.socket.asyncListen(this);
    this.port = /** @type {number} */ (this.socket.port);
  }

  /** nsIServerSocketListener @param {any} _socket @param {any} transport */
  onSocketAccepted(_socket, transport) {
    const connection = new Connection(this, transport);
    if (this.waiting.size >= MAX_WAITING) {
      // Evict the oldest waiting connection, answering busy so its client can retry; it lingers
      // in `closing` (not counted) until its client closes or DRAIN_MS pass.
      const oldest = /** @type {Connection} */ (this.waiting.values().next().value);
      this.waiting.delete(oldest);
      this.refuse(oldest, "busy", `evicted: ${MAX_WAITING} newer connections are waiting`);
    }
    this.waiting.add(connection);
    connection.start();
  }

  /**
   * Answer `code` and close. Up to MAX_CLOSING refused connections linger to let their client
   * read the answer (see Connection.fail); beyond that a flood gets the answer written and an
   * immediate close, so refused connections cannot pile up either.
   * @param {Connection} connection @param {string} code @param {string} message
   */
  refuse(connection, code, message) {
    if (this.closing.size >= MAX_CLOSING) {
      connection.respond(null, { error: { code, message } });
      connection.closeAfterWrite = true;
      connection.flush();
      return;
    }
    this.closing.add(connection);
    connection.fail(null, code, message);
  }

  /**
   * A switch flipped while running: serve `roles` from now on, and close every connection of a
   * role that went off (`:mcp off` ends the agents' connections, and with them their grants).
   * @param {Role[]} roles
   */
  setRoles(roles) {
    this.roles = roles;
    // A ticket's connection does not depend on a switch: it ends with its ticket.
    for (const c of [...this.connections, ...this.waiting]) {
      if (c.role && !c.ticket && !roles.includes(c.role)) c.stop();
    }
  }

  onStopListening() {}

  stop() {
    this.socket.close();
    for (const c of [...this.connections, ...this.waiting, ...this.closing]) c.stop();
  }
}

/** @type {Server | null} */
let server = null;
let initialised = false;
/** quit-application-granted and the shutdown blocker are registered once per process. */
let hooksAdded = false;
/** The pref observer is registered (init) and not yet removed (shutdown). */
let watching = false;
/** After shutdown nothing starts again (until _restartForTests). */
let quitting = false;
/** Resolves once the first browser window has finished its delayed startup, or at shutdown. */
let windowReady = Promise.resolve();
/** @type {(() => void) | null} */
let releaseWindowWait = null;
/** start/stop run one after another, so quick pref flips settle in order. */
let chain = Promise.resolve();

const discoveryPath = () => PathUtils.join(PathUtils.profileDir, DISCOVERY_FILE);

/**
 * Remove whatever a previous run left at the discovery path, so no client ever dials a port
 * from a dead run (another local user could have bound it; security.md S6). A symlink is
 * removed, not followed. A real directory is left alone and reported: false means "do not
 * write the file" (a rename would move it into the directory).
 */
function removeDiscoveryFile() {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(discoveryPath());
  // isSymlink() throws for a path that does not exist at all (not even a dangling link).
  let link;
  try {
    link = file.isSymlink();
  } catch (e) {
    if (/** @type {any} */ (e).result === Cr.NS_ERROR_FILE_NOT_FOUND) return true;
    throw e;
  }
  if (link) {
    file.remove(false);
    return true;
  }
  if (file.isDirectory()) {
    console.error(`vimma control: ${file.path} is a directory; not starting the control socket`);
    return false;
  }
  file.remove(false);
  return true;
}

/**
 * The discovery file's contents for `s`: protocol 2 lists the roles (vimma-mcp decision 2), and
 * Vimma's version lets `vimma-ctl mcp` say it is older before it connects (spec ship-vimma-ctl,
 * behaviour 5). A build whose display version is not X.Y.Z leaves it out.
 */
function discoveryOf(/** @type {Server} */ s) {
  const version = lazy.AppConstants.MOZ_APP_VERSION_DISPLAY;
  return {
    protocol: LATEST_PROTOCOL,
    port: s.port,
    token: s.token,
    pid: Services.appinfo.processID,
    roles: s.roles,
    ...(isCtlVersion(version) ? { version } : {}),
  };
}

/**
 * Start the server, or bring a running one up to date: it serves the switches' roles, and runs
 * with none while a ticket is live. The discovery file exists only while a role is served: a
 * ticket's CLI gets the port from Vimma, and no other process needs to find a listener that
 * takes nothing but tickets.
 */
async function startServer() {
  await windowReady;
  const roles = enabledRoles();
  if (quitting || (!roles.length && !tickets.size)) return;
  if (server) {
    // Running: only the roles changed. The file says so; the token and port stay.
    if (server.roles.join() === roles.join()) return;
    server.setRoles(roles);
    if (roles.length) await writeDiscovery(discoveryOf(server));
    else removeDiscoveryFile();
    return;
  }
  // A directory where the file goes keeps the switches' roles off (S6); tickets need no file.
  if (!removeDiscoveryFile() && roles.length) return;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const s = new Server(hex(bytes), roles);
  if (roles.length) {
    try {
      await writeDiscovery(discoveryOf(s));
    } catch (e) {
      s.stop();
      throw e;
    }
  }
  server = s;
}

/** The server runs while a switch is on or a ticket is live. */
const wanted = () => enabledRoles().length > 0 || tickets.size > 0;

/**
 * The ticket ends: its connection, and any still in its handshake, close at once, and the
 * listener stops if nothing else needs it.
 * @param {Ticket} ticket
 */
function revoke(ticket) {
  tickets.delete(ticket.id);
  for (const c of server ? [...server.connections, ...server.waiting] : []) {
    if (c.ticket === ticket) c.close();
  }
  ticket.live?.close();
  if (!tickets.size) enqueue(() => (wanted() ? undefined : stopServer()));
}

/**
 * Atomically, and 0600 from the first byte: create the temporary file with mode 0600, write
 * into it (an "overwrite" write keeps the file's mode), then rename it over the real name.
 * IOUtils.writeJSON's tmpPath would create the temporary file 0644 first.
 * @param {object} discovery
 */
async function writeDiscovery(discovery) {
  const tmp = await IOUtils.createUniqueFile(PathUtils.profileDir, `${DISCOVERY_FILE}.tmp`, 0o600);
  try {
    await IOUtils.writeUTF8(tmp, JSON.stringify(discovery) + "\n");
    await IOUtils.move(tmp, discoveryPath());
  } catch (e) {
    await IOUtils.remove(tmp, { ignoreAbsent: true });
    throw e;
  }
}

/** The file goes first, then the socket: no moment where the file names a free port. */
async function stopServer() {
  removeDiscoveryFile();
  if (!server) return;
  const s = server;
  server = null;
  s.stop();
}

/** @param {() => Promise<void> | void} step */
function enqueue(step) {
  chain = chain.then(step).catch((e) => console.error("vimma control:", e));
  return chain;
}

function apply() {
  // `:mcp off` (or [mcp] enabled = false): the log of agent calls goes too (mcp-drive D14), and
  // so do the grants, a dropped link's included (mcp-session-grants S5).
  if (McpHost.state.enabled) AgentGate.on();
  else AgentGate.off();
  return enqueue(() => (wanted() ? startServer() : stopServer()));
}

export const VimmaControl = {
  /**
   * Called by every browser window. The first call removes a discovery file left by an earlier
   * run (whatever the pref says) and starts watching the pref, but the server starts only once
   * that window has finished its delayed startup: a client that sees the discovery file must
   * find a window to send keys to and report on (the e2e harness saw "no browser window").
   * @param {Window | { gBrowserInit?: { delayedStartupFinished?: boolean } }} win
   */
  init(win) {
    if (initialised) return;
    initialised = true;
    const w = /** @type {any} */ (win);
    if (!w.gBrowserInit?.delayedStartupFinished) {
      windowReady = new Promise((resolve) => {
        /** @param {unknown} subject */
        const observer = (subject) => {
          if (subject !== win) return;
          release();
        };
        const release = () => {
          Services.obs.removeObserver(observer, "browser-delayed-startup-finished");
          releaseWindowWait = null;
          resolve(undefined);
        };
        releaseWindowWait = release;
        Services.obs.addObserver(observer, "browser-delayed-startup-finished");
      });
    }
    enqueue(() => {
      removeDiscoveryFile();
    });
    Services.prefs.addObserver(ENABLED_PREF, apply);
    Services.prefs.addObserver(MCP_ENABLED_PREF, apply);
    Services.obs.addObserver(apply, MCP_CHANGED_TOPIC);
    watching = true;
    if (!hooksAdded) {
      hooksAdded = true;
      Services.obs.addObserver(() => this.shutdown(), "quit-application-granted");
      // In case quit-application-granted was skipped (e.g. a forced quit): the file must go.
      lazy.AsyncShutdown.profileBeforeChange.addBlocker(
        "VimmaControl: remove the discovery file",
        () => this.shutdown(),
      );
    }
    apply();
  },

  /**
   * Stop the server and remove the discovery file. Never waits for a window: if the first one
   * closed before its delayed startup, a pending start is released and does nothing.
   */
  shutdown() {
    quitting = true;
    releaseWindowWait?.();
    if (watching) {
      Services.prefs.removeObserver(ENABLED_PREF, apply);
      Services.prefs.removeObserver(MCP_ENABLED_PREF, apply);
      Services.obs.removeObserver(apply, MCP_CHANGED_TOPIC);
      watching = false;
    }
    return enqueue(stopServer);
  },

  /**
   * A one-time ticket for an agent CLI's run (docs/specs/builtin-agent-cli.md C3): 256 random
   * bits bound to the conversation's gate connection, good for one connection (and its
   * reconnects by session id) until `revokeTicket`. Starts the listener if it is off. The
   * ticket goes only into the CLI's environment: never a pref, a file, a log or a notice.
   * @param {{ conn: string, state: import("./agent-commands.mjs").AgentConn, label: string }} binding
   *   the conversation's connection and state, and the CLI's name for a notice
   * @returns {Promise<{ ticket: string, port: number }>}
   */
  async issueTicket({ conn, state, label }) {
    if (quitting) throw new Error("Vimma is shutting down");
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const ticket = hex(bytes);
    const id = await hmacHex(ticket, TICKET_CONTEXT);
    /** @type {Ticket} */
    const t = { ticket, id, conn, state, label, live: null, used: false, session: null };
    tickets.set(id, t);
    await enqueue(startServer);
    if (!server || tickets.get(id) !== t) {
      tickets.delete(id);
      throw new Error("the control socket could not start for the agent CLI");
    }
    return { ticket, port: server.port };
  },

  /** The run ended: its ticket and its connection go at once. @param {string} ticket */
  revokeTicket(ticket) {
    for (const t of tickets.values()) if (t.ticket === ticket) revoke(t);
  },

  /** Every ticket of a conversation's connection goes (a stop, a delete). @param {string} conn */
  revokeTickets(conn) {
    for (const t of [...tickets.values()]) if (t.conn === conn) revoke(t);
  },

  /** Resolves once pending starts and stops are done (tests). */
  settled() {
    return chain;
  },

  /**
   * Test-only: shut down, run `before` (e.g. leave a stale file), then start over as at app
   * startup with `win` as the first window.
   * @param {any} win
   * @param {() => Promise<unknown> | unknown} [before]
   */
  async _restartForTests(win, before) {
    await this.shutdown();
    await before?.();
    initialised = false;
    quitting = false;
    this.init(win);
    if (win.gBrowserInit?.delayedStartupFinished) await chain;
  },

  /** Test-only: the commands, to check their own argument checks. */
  _commands: COMMANDS,

  /** The listening port, or null while stopped. */
  get port() {
    return server?.port ?? null;
  },

  /** Authenticated connections (tests). */
  get connections() {
    return server?.connections.size ?? 0;
  },

  /** Refused connections lingering for their answer (tests). */
  get closing() {
    return server?.closing.size ?? 0;
  },

  /** Connections waiting for a hello (tests). */
  get waiting() {
    return server?.waiting.size ?? 0;
  },
};
