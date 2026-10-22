/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The agent role's gate (docs/specs/vimma-mcp.md, decisions 12-22): every agent request but
// hello and ping waits here for the user's answer, or runs under a grant of its connection and
// tool. Core's AgentQueue holds the rules (the queue and its caps, the mute, the grants); this
// adds the clock: the ask timeout (50 s, `[mcp] ask_timeout`) and the grants' expiry. One per
// app, in memory only: nothing here is written to disk (decision 22), and a restart ends it all.
//
// The question itself (ui/agent-prompt.mjs, host/agent-ui.mjs: the line, the status bar's
// `◇ agent 1?`, `ctrl+b shift+a`) watches the gate through `addListener` and answers through
// `answer`. While MCP is on, a new full-control connection asks here too (`askFull`, decision
// 29 C), as a question of its own that no grant can cover.
//
// Every agent request that is answered, runs under a grant or is denied goes into `:mcp log`
// (docs/specs/mcp-drive.md D14), the last 100, in memory only like the grants.

import { AgentLog, AgentQueue, grantLength } from "../core/agent.mjs";
import { FULL_CONTROL, PAGE_CLIENT, SHOW_TOOL } from "../core/agent-prompt.mjs";
import { McpHost } from "../host/mcp-ops.mjs";

/** @import { Answer, ConnId } from "../core/agent.mjs" */

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Test-only: the ask timeout in ms, in place of `[mcp] ask_timeout`. */
const ASK_TIMEOUT_PREF = "vimma.mcp.askTimeoutMs";
const DEFAULT_ASK_TIMEOUT_S = 50;
const DEFAULT_GRANT = { grantMinutes: 10, grantMaxMinutes: 480 };

/**
 * @typedef {{ allow: true, grant?: { until: number } }
 *   | { allow: false, reason: "user" | "timeout" | "busy" | "muted" | "cancelled" }} Outcome
 * @typedef {{ client: string, version?: string, via?: string, since: number }} AgentLabel
 * @typedef {{ id: number, conn: ConnId, tool: string, what: object, label: AgentLabel,
 *   asked: number, deadline: number }} Question
 * @typedef {{ kind: "asked", question: Question }
 *   | { kind: "answered", question: Question, answer: string,
 *       length: { minutes: number, capped: boolean } | null }
 *   | { kind: "timeout", question: Question }
 *   | { kind: "ran", conn: ConnId, tool: string, what: object, label: AgentLabel,
 *       until: number }
 *   | { kind: "notice", text: string }} GateEvent  what listeners hear, for the notices
 *   (decisions 16, 20, 23; `notice`: an agent download's, decision 31)
 */

const queue = new AgentQueue();
/** Agent connections after their hello: what the question and `:mcp` call them. */
/** @type {Map<ConnId, AgentLabel>} */
const labels = new Map();
/** Waiting requests: what is asked, and how to answer the agent. */
/** @type {Map<number, Question & { resolve: (o: Outcome) => void, timer: any }>} */
const pending = new Map();
/** @type {Set<(event?: GateEvent) => void>} */
const listeners = new Set();
/** When an allowed request last ran (the status bar's `◇ agent ·`). @type {number | null} */
let ranAt = null;
/** The queue's key for full-control questions (decision 29 C); never an agent connection. */
const FULL_CONN = "full";
/**
 * The queue's key for downloads no agent connection asked for (decision 31): a page's own in the
 * agent workspace, or one whose agent is gone. Never granted; `x` is a plain no.
 */
const PAGE_CONN = "page";
/** `:mcp log`: the agents' calls and what came of them. */
const log = new AgentLog();

/**
 * One call into the log: who, what it touched as its question showed it, and the outcome.
 * Full control's questions are not an agent's calls (it has `:control` and its own notices).
 * @param {ConnId} conn @param {string} tool @param {any} what
 * @param {import("../core/agent.mjs").LogOutcome} outcome
 * @param {string} [why]  what stopped a call that ran (`stopped`)
 */
function record(conn, tool, what, outcome, why) {
  if (conn === FULL_CONN) return;
  const w = what ?? {};
  const detail =
    typeof w.keys === "string"
      ? w.keys
      : typeof w.url === "string"
        ? w.url
        : typeof w.name === "string"
          ? w.name
          : Number.isInteger(w.count)
            ? `${w.count} tabs`
            : "";
  log.add({
    at: Date.now(),
    client: labels.get(conn)?.client ?? "",
    tool,
    title: typeof w.title === "string" ? w.title : "",
    detail,
    outcome,
    ...(why ? { why } : {}),
  });
}

/** Connections that are not an agent's: no grant, and not listed. */
/** @type {Set<ConnId>} */
const NOT_AGENTS = new Set([FULL_CONN, PAGE_CONN]);

/**
 * Withdraw question `id` unanswered: its connection went away.
 * @param {number} id
 */
function cancel(id) {
  const p = pending.get(id);
  if (!p || !queue.cancel(id)) return;
  pending.delete(id);
  lazy.clearTimeout(p.timer);
  record(p.conn, p.tool, p.what, "cancelled");
  p.resolve({ allow: false, reason: "cancelled" });
  changed();
}

/** @param {GateEvent} [event] */
function changed(event) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error("vimma agent gate:", e);
    }
  }
}

/** @param {number} id */
const questionOf = (id) => {
  const p = pending.get(id);
  if (!p) return null;
  const { conn, tool, what, label, asked, deadline } = p;
  return { id, conn, tool, what, label, asked, deadline };
};

function askTimeoutMs() {
  const override = Services.prefs.getIntPref(ASK_TIMEOUT_PREF, 0);
  if (override > 0) return override;
  return (McpHost.config?.askTimeout ?? DEFAULT_ASK_TIMEOUT_S) * 1000;
}

/**
 * Answer the agents of the requests `resolved` names.
 * @param {{ id: number, allow: boolean, reason?: string }[]} resolved
 * @param {{ until: number }} [grant]
 */
function settle(resolved, grant) {
  for (const r of resolved) {
    const p = pending.get(r.id);
    if (!p) continue;
    pending.delete(r.id);
    lazy.clearTimeout(p.timer);
    record(
      p.conn,
      p.tool,
      p.what,
      r.allow ? "yes" : /** @type {any} */ (r.reason === "muted" ? "muted" : r.reason),
    );
    if (r.allow) ranAt = Date.now();
    p.resolve(
      r.allow
        ? { allow: true, ...(grant ? { grant: { until: grant.until } } : {}) }
        : /** @type {Outcome} */ ({ allow: false, reason: r.reason }),
    );
  }
}

export const AgentGate = {
  /**
   * An agent connection said hello: it may ask from now on.
   * @param {ConnId} conn
   * @param {{ client: string, version?: string, via?: string }} label  self-reported: labels only
   */
  connect(conn, label) {
    queue.connect(conn);
    labels.set(conn, { ...label, since: Date.now() });
    changed();
  },

  /**
   * The connection closed: its waiting requests go unanswered and its grants end (decision 22).
   * @param {ConnId} conn
   */
  disconnect(conn) {
    const had = labels.delete(conn);
    for (const id of queue.disconnect(conn)) {
      const p = pending.get(id);
      if (!p) continue;
      pending.delete(id);
      lazy.clearTimeout(p.timer);
      record(p.conn, p.tool, p.what, "cancelled");
      p.resolve({ allow: false, reason: "cancelled" });
    }
    if (had) changed();
  },

  /**
   * An agent request: resolves once it may run (a yes, or a grant of its connection and tool)
   * or is denied (no, timeout, busy, muted). The caller checks again, when it runs, that what
   * was asked about is still so (decision 19).
   * @param {ConnId} conn
   * @param {string} tool  the MCP tool (core AGENT_TOOLS)
   * @param {object} what  what it touches, for the question: plain data, shown as text
   * @param {{ always?: boolean, onCancel?: (cancel: () => void) => void }} [options]
   *   `always`: ask even under a grant (a dangerous download, decision 31 d); `onCancel` is
   *   given a way to withdraw the question unanswered
   * @returns {Promise<Outcome>}
   */
  request(conn, tool, what, { always = false, onCancel } = {}) {
    const label = labels.get(conn);
    if (!label) return Promise.resolve({ allow: false, reason: "busy" });
    const now = Date.now();
    const admission = queue.ask(conn, tool, now, { always });
    if (admission.kind === "run") {
      record(conn, tool, what, "grant");
      ranAt = now;
      changed({ kind: "ran", conn, tool, what, label, until: admission.grant.until });
      return Promise.resolve({ allow: true, grant: { until: admission.grant.until } });
    }
    if (admission.kind === "deny") {
      record(conn, tool, what, admission.reason);
      return Promise.resolve({ allow: false, reason: admission.reason });
    }
    const { id } = admission;
    const timeout = askTimeoutMs();
    return new Promise((resolve) => {
      const timer = lazy.setTimeout(() => {
        const question = questionOf(id);
        settle(queue.expire(id, Date.now()).resolved);
        changed(question ? { kind: "timeout", question } : undefined);
      }, timeout);
      pending.set(id, {
        id,
        conn,
        tool,
        what,
        label,
        asked: now,
        deadline: now + timeout,
        resolve,
        timer,
      });
      onCancel?.(() => cancel(id));
      changed({ kind: "asked", question: /** @type {Question} */ (questionOf(id)) });
    });
  },

  /**
   * A download no agent connection asked for (decision 31): asks as "a page in the agent
   * workspace", with no grant.
   * @param {string} tool @param {object} what
   * @param {{ always?: boolean, onCancel?: (cancel: () => void) => void }} [options]
   * @returns {Promise<Outcome>}
   */
  askPage(tool, what, options) {
    if (!labels.has(PAGE_CONN)) this.connect(PAGE_CONN, { client: PAGE_CLIENT });
    return this.request(PAGE_CONN, tool, what, options);
  },

  /**
   * Whether `conn` is an agent connection after its hello, still open.
   * @param {ConnId | null | undefined} conn
   */
  isConnected(conn) {
    return conn !== null && conn !== undefined && !NOT_AGENTS.has(conn) && labels.has(conn);
  },

  /**
   * A notice for the window that asks (an agent download's, decision 31).
   * @param {string} text
   */
  notify(text) {
    changed({ kind: "notice", text });
  },

  /**
   * A new full-control connection while MCP is on (decision 29 C): resolves once the user answered
   * yes, or with the denial (no, `x`, timeout, a full queue). Nothing is remembered: the next
   * connection asks again.
   * @param {string | null} code  the code the client printed on its terminal, shown in the
   *   question so the user answers for the client they ran (security.md S13)
   * @param {(cancel: () => void) => void} [onCancel]  given a way to withdraw the question
   *   (the connection closed while it waited)
   * @returns {Promise<Outcome>}
   */
  askFull(code, onCancel) {
    // One connection key for every full-control question: one waits at a time, and three noes
    // in a row mute them all for a minute (decision 18), so a token holder cannot flood.
    if (!labels.has(FULL_CONN)) this.connect(FULL_CONN, { client: "vimma-ctl" });
    if (AgentGate.waiting.some((q) => q.conn === FULL_CONN)) {
      return Promise.resolve({ allow: false, reason: "busy" });
    }
    const outcome = this.request(FULL_CONN, FULL_CONTROL, code ? { code } : {});
    const mine = [...pending.values()].find((p) => p.conn === FULL_CONN);
    if (mine) onCancel?.(() => cancel(mine.id));
    return outcome;
  },

  /**
   * The user's answer to question `id` (the prompt line): `once`, `deny`, `mute`
   * (`x`), or `grant` for `minutes` (capped at `[mcp] grant_max_minutes`).
   * @param {number} id
   * @param {Answer | { kind: "grant", minutes: number | null }} answer
   * @returns {{ minutes: number, capped: boolean } | null} the grant's length, for a grant
   */
  answer(id, answer) {
    const question = questionOf(id);
    let length = null;
    /** @type {Answer} */
    let final = /** @type {Answer} */ (answer);
    // Full control, a page's download and a show (mcp-drive D4) are one yes or no: no grant
    // covers them, and `x` is a plain no.
    if (
      question?.tool === FULL_CONTROL ||
      question?.tool === SHOW_TOOL ||
      question?.conn === PAGE_CONN
    ) {
      if (answer.kind === "grant") return null;
      if (answer.kind === "mute") final = { kind: "deny" };
    }
    // A dangerous download is allowed for that one file only (decision 31 d): no grant.
    const asked = /** @type {any} */ (question?.what);
    if (answer.kind === "grant" && (asked?.danger || asked?.unscanned)) return null;
    if (answer.kind === "grant") {
      length = grantLength(answer.minutes, McpHost.config ?? DEFAULT_GRANT);
      final = { kind: "grant", minutes: length.minutes };
    }
    const { resolved, grant } = queue.answer(id, final, Date.now());
    settle(resolved, grant);
    const granted = resolved.length && length ? length : null;
    changed(
      question && resolved.length
        ? { kind: "answered", question, answer: final.kind, length: granted }
        : undefined,
    );
    return granted;
  },

  /**
   * End every grant (`:mcp revoke`, decision 22).
   * @returns {number} how many ended
   */
  revoke() {
    const n = queue.revoke();
    if (n) changed();
    return n;
  },

  /**
   * The waiting questions, oldest first: the one to ask now is the first.
   * @returns {Question[]}
   */
  get waiting() {
    return queue.waiting.flatMap((r) => {
      const p = pending.get(r.id);
      if (!p) return [];
      const { id, conn, tool, what, label, asked, deadline } = p;
      return [{ id, conn, tool, what, label, asked, deadline }];
    });
  },

  /**
   * A notice for a step of a call that runs under a grant (mcp-drive D14: a follow names the
   * host it loaded), shown like the call's own.
   * @param {ConnId} conn @param {string} tool @param {object} what @param {number} until
   */
  announce(conn, tool, what, until) {
    const label = labels.get(conn);
    // A grant revoked while the call ran shows no "(grant, …left)".
    const grant = queue.grants(Date.now()).find((g) => g.conn === conn && g.tool === tool);
    if (!label || !grant) return;
    changed({ kind: "ran", conn, tool, what, label, until: Math.min(until, grant.until) });
  },

  /** `:mcp log`'s rows, newest first (mcp-drive D14). */
  get log() {
    return log.entries();
  },

  /**
   * A call's outcome decided outside the gate, for `:mcp log` (mcp-drive D14, M23): denied
   * before or after the question (`busy`, `in-use`, `changed`), or stopped while it ran.
   * @param {ConnId} conn @param {string} tool @param {object} what
   * @param {import("../core/agent.mjs").LogOutcome} outcome @param {string} [why]
   */
  note(conn, tool, what, outcome, why) {
    record(conn, tool, what, outcome, why);
  },

  /** `:mcp off`: the log goes with the agents. */
  clearLog() {
    log.clear();
  },

  /** When an allowed request last ran, or null. */
  get ranAt() {
    return ranAt;
  },

  /** Grants in force, the one ending first first, with their connection's label. */
  grants() {
    return queue.grants(Date.now()).map((g) => ({ ...g, label: labels.get(g.conn) ?? null }));
  },

  /** Agent connections and their labels (`:mcp`, about:vimma); never a full-control question's. */
  get connections() {
    return [...labels.entries()].filter(([conn]) => !NOT_AGENTS.has(conn)).map(([, l]) => l);
  },

  /**
   * @param {(event?: GateEvent) => void} listener  told after any change: a question, an
   *   answer, a grant, a call under a grant
   */
  addListener(listener) {
    listeners.add(listener);
  },

  /** @param {(event?: GateEvent) => void} listener */
  removeListener(listener) {
    listeners.delete(listener);
  },
};
