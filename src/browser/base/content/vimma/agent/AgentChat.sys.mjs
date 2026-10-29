/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's conversations (docs/specs/builtin-agent.md B4, B5, B17, B18, Behaviour
// 24-26, 29-34). Each conversation is one gate connection, `builtin:<n>`, in this process: its
// tool calls run through runAgentCommand, as an MCP agent's do through the control socket, so
// the gate, the grants, the checkpoints, the rates, `:mcp log` and the checks after a yes are the
// same code; and it needs no `:mcp on`, which opens the socket to every local process. Sending
// a task with `Enter` grants the conversation's connection, with no question, for its lifetime;
// `ask` (`ctrl+Enter`) ends that grant so every step asks. The model loop is vimma-core's, the
// one the bench measures. Kept in memory; the chat window and the stored conversations come in
// later deliveries, and until then the feature pref keeps it off.

import { Budget } from "../core/agent-budget.mjs";
import { startTask } from "../core/agent-loop.mjs";
import { checkEndpoint } from "../core/agent-providers.mjs";
import { failureResult, toolCommand, toolResult } from "../core/agent-results.mjs";
import { modelChoices, prepareLocalModel, probeLocal } from "../core/agent-setup.mjs";
import { AGENT_INSTRUCTIONS, agentTools } from "../core/agent-tools.mjs";
import { BUILTIN_CONN_PREFIX, builtinLabel } from "../core/agent.mjs";
import { AGENT_DEFAULTS } from "../core/config.mjs";
import { validateMessage } from "../core/control.mjs";
import {
  AgentError,
  AgentTabOwners,
  builtinHello,
  forgetAgentConnection,
  runAgentCommand,
} from "../ctl/agent-commands.mjs";
import { AgentGate } from "../ctl/AgentGate.sys.mjs";
import { McpHost } from "../host/mcp-ops.mjs";
import { AgentKeys } from "./AgentKeys.sys.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * @typedef {import("../core/config.mjs").AgentProviderConfig} AgentProviderConfig
 * @typedef {import("../core/agent-loop.mjs").TaskResult} TaskResult
 * @typedef {import("../core/agent-loop.mjs").TaskEvent} TaskEvent
 * @typedef {import("../core/agent-providers.mjs").ChatMessage} ChatMessage
 * @typedef {{ id: number, conn: string, title: string, provider: AgentProviderConfig,
 *   state: import("../ctl/agent-commands.mjs").AgentConn, messages: ChatMessage[],
 *   task: { stop(): void, steer(text: string): void } | null, starting: boolean,
 *   stopped: boolean,
 *   budget: Budget | null, done: Promise<TaskResult> | null,
 *   last: { outcome: string, error?: string } | null }} Conversation
 */

/** Unfinished: off until the chat window lands (CONTRIBUTING.md, "Unfinished features"). */
export const FEATURE_PREF = "vimma.feature.agentChat";
/** A conversation's title: the first line of its first message, cut at 40 columns (Behaviour 19). */
const TITLE_COLUMNS = 40;

/** @type {Map<number, Conversation>} */
const conversations = new Map();
let nextId = 1;
/** Request ids for `agent-cancel`, unique across conversations. */
let nextRid = 1;
/** @type {Set<() => void>} */
const listeners = new Set();

function changed() {
  for (const listener of listeners) {
    try {
      listener();
    } catch (e) {
      console.error("vimma agent chat:", e);
    }
  }
}

/** The parent process's fetch: requests from the system principal, with no page's cookies. */
const parentFetch = (/** @type {string} */ url, /** @type {any} */ init) => fetch(url, init);

const config = () => McpHost.agentConfig;

/** A signal that aborts after `ms`: this module's global has no AbortSignal.timeout. */
function timeout(/** @type {number} */ ms) {
  const controller = new AbortController();
  lazy.setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

/** @param {number} id */
function conversation(id) {
  const c = conversations.get(id);
  if (!c) throw new Error(`no agent conversation ${id}`);
  return c;
}

/** @param {string} text */
function titleOf(text) {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return [...line.trim()].slice(0, TITLE_COLUMNS).join("") || "New conversation";
}

/**
 * A stopped task no longer counts: it starts no further step, though a step already running
 * finishes (Behaviour 16).
 * @param {Conversation} c
 */
const isRunning = (c) => (c.task !== null && !c.stopped) || c.starting;

/**
 * One tool call of conversation `c`, as an agent command on its connection, its result as the
 * text vimma-ctl mcp gives an MCP agent. Stopping the task withdraws a question it waits on.
 * @param {Conversation} c @param {string} name @param {Record<string, any>} args
 * @param {{ signal: AbortSignal }} opts
 */
async function runTool(c, name, args, { signal }) {
  const mapped = toolCommand(name, args);
  if (!mapped) {
    return failureResult({ kind: "refused", code: "invalid-args", message: `no tool ${name}` });
  }
  const rid = nextRid++;
  // The checks a socket request gets (control protocol 2), before anything is asked.
  const check = validateMessage(
    { type: "request", id: rid, command: mapped.command, args: mapped.args },
    { kind: "request" },
  );
  if (!check.valid) {
    const message = check.errors.map((e) => e.replace(/^args\./, "")).join("; ");
    return failureResult({ kind: "refused", code: "invalid-args", message });
  }
  const withdraw = () => c.state.cancels?.get(rid)?.();
  signal.addEventListener("abort", withdraw);
  const asked = Date.now();
  try {
    const result = await runAgentCommand(c.conn, c.state, mapped.command, mapped.args, rid);
    return toolResult(name, args, result);
  } catch (e) {
    if (!(e instanceof AgentError)) throw e;
    return failureResult(
      e.code === "denied"
        ? { kind: "denied", reason: e.reason ?? "user", waitedS: (Date.now() - asked) / 1000 }
        : { kind: "refused", code: e.code, message: e.message },
    );
  } finally {
    signal.removeEventListener("abort", withdraw);
  }
}

/**
 * The key for `provider`'s requests: the one stored for its name and endpoint, or none (a
 * local server takes none).
 * @param {AgentProviderConfig} provider
 */
async function keyFor(provider) {
  if (!(await AgentKeys.has(provider.name))) return "";
  return (await AgentKeys.get(provider.name, provider.endpoint)) ?? "";
}

/** What a conversation shows of itself: never its key, which it does not hold. */
function view(/** @type {Conversation} */ c) {
  const { name, kind, endpoint, model } = c.provider;
  return {
    id: c.id,
    conn: c.conn,
    title: c.title,
    provider: { name, kind, endpoint, model },
    running: isRunning(c),
    granted: AgentGate.grants().some((g) => g.conn === c.conn),
    budget: c.budget?.status() ?? null,
    last: c.last,
  };
}

export const AgentChat = {
  get enabled() {
    return Services.prefs.getBoolPref(FEATURE_PREF, false);
  },

  /**
   * A new conversation, on a connection of its own that starts without a grant (B5).
   * @param {{ provider: AgentProviderConfig, title?: string }} opts
   */
  create({ provider, title = "" }) {
    if (!this.enabled) {
      throw new Error(`the built-in agent is unfinished and off (${FEATURE_PREF})`);
    }
    const id = nextId++;
    /** @type {Conversation} */
    const c = {
      id,
      conn: `${BUILTIN_CONN_PREFIX}${id}`,
      title,
      provider,
      state: {},
      messages: [],
      task: null,
      starting: false,
      stopped: false,
      budget: null,
      done: null,
      last: null,
    };
    builtinHello(c.conn, c.state, {
      client: builtinLabel(title || "New conversation"),
      via: `${provider.name} · ${provider.model}`,
    });
    conversations.set(id, c);
    changed();
    return view(c);
  },

  /**
   * The user sends `text` (Behaviour 15, 24-25, 32). With `ask` (ctrl+Enter) every step asks;
   * without (Enter) the key press grants the conversation's connection. A message sent while a
   * task runs reaches the model at its next turn.
   * @param {number} id @param {string} text @param {{ ask?: boolean }} [opts]
   * @returns {Promise<{ started: true } | { steered: true } | { refused: string }>}
   */
  async send(id, text, { ask = false } = {}) {
    const c = conversation(id);
    const max = config()?.maxRunning ?? AGENT_DEFAULTS.maxRunning;
    const localOnly = config()?.localOnly ?? false;
    if (!isRunning(c)) {
      if (this.running >= max) {
        return { refused: `${max} agent tasks are running ([agent] max_running); s stops one` };
      }
      const refused = checkEndpoint(c.provider.endpoint, { localOnly });
      if (refused) return { refused };
    }
    if (!c.title) {
      c.title = titleOf(text);
      AgentGate.relabel(c.conn, builtinLabel(c.title));
    }
    /** The send's effect on the grant: made by Enter, ended by ctrl+Enter (B18). */
    const applyGrant = () => (ask ? AgentGate.endGrant(c.conn) : AgentGate.grantConnection(c.conn));
    if (c.task && !c.stopped) {
      applyGrant();
      c.task.steer(text);
      return { steered: true };
    }
    // Held from here, before the awaits, so two sends cannot both take the last place.
    c.starting = true;
    changed();
    let key;
    try {
      key = await keyFor(c.provider);
    } catch (e) {
      c.starting = false;
      changed();
      console.error("vimma agent: the provider's key could not be read", e);
      return { refused: `the key of ${c.provider.name} could not be read` };
    }
    if (!conversations.has(id) || !c.starting) return { refused: "the conversation was stopped" };
    // Only now, so a send that starts no task leaves no grant behind.
    applyGrant();
    const limits = config() ?? AGENT_DEFAULTS;
    const budget = new Budget(
      { maxSteps: limits.maxSteps, maxTokens: limits.maxTokens, maxCost: limits.maxCost },
      c.provider,
    );
    const handle = startTask({
      provider: c.provider,
      fetch: parentFetch,
      key,
      system: AGENT_INSTRUCTIONS,
      tools: agentTools({ vision: c.provider.vision }),
      messages: [...c.messages, { role: "user", text }],
      runTool: (name, args, opts) => runTool(c, name, args, opts),
      budget,
      localOnly,
      onEvent: () => changed(),
    });
    c.starting = false;
    c.stopped = false;
    c.task = handle;
    c.budget = budget;
    c.done = handle.done.then(
      (result) => {
        c.messages = result.messages;
        if (c.task === handle) c.task = null;
        c.last = { outcome: result.outcome, ...(result.error ? { error: result.error } : {}) };
        changed();
        return result;
      },
      (e) => {
        if (c.task === handle) c.task = null;
        c.last = { outcome: "error", error: String(e?.message ?? e) };
        changed();
        throw e;
      },
    );
    return { started: true };
  },

  /**
   * The running task's result, once it ends; the last one when none runs.
   * @param {number} id
   * @returns {Promise<TaskResult>}
   */
  done(id) {
    const c = conversation(id);
    if (!c.done) return Promise.reject(new Error("no task was sent"));
    return c.done;
  },

  /**
   * `s`, `:agent stop` (Behaviour 16): the request to the model is aborted, a question waiting
   * is withdrawn, no further step starts, and the conversation's grant ends.
   * @param {number} id
   */
  stop(id) {
    const c = conversation(id);
    c.starting = false;
    if (c.task) c.stopped = true;
    c.task?.stop();
    for (const withdraw of [...(c.state.cancels?.values() ?? [])]) withdraw();
    AgentGate.endGrant(c.conn);
    changed();
  },

  /** `ctrl+b shift+a` with no question waiting: every running task stops (Behaviour 16). */
  stopAll() {
    for (const c of conversations.values()) if (isRunning(c)) this.stop(c.id);
  },

  /**
   * The conversation goes, with its connection, its grant and its claim on its tabs.
   * @param {number} id
   */
  delete(id) {
    const c = conversations.get(id);
    if (!c) return;
    this.stop(id);
    AgentGate.disconnect(c.conn);
    forgetAgentConnection(c.conn);
    AgentTabOwners.forget(c.conn);
    conversations.delete(id);
    changed();
  },

  /** @param {number} id */
  get(id) {
    return view(conversation(id));
  },

  list() {
    return [...conversations.values()].map(view);
  },

  /** How many conversations run a task now. */
  get running() {
    return [...conversations.values()].filter(isRunning).length;
  },

  /**
   * Setup's probe of the local servers (Behaviour 2): only on 127.0.0.1, only when setup asks.
   * @param {{ servers?: { server: string, port: number }[] }} [opts]  a test's own server
   */
  probe(opts) {
    return probeLocal(parentFetch, { ...opts, timeout });
  },

  /** The probe's servers as the picker lists them. @param {Awaited<ReturnType<typeof probeLocal>>} found */
  choices(found) {
    return modelChoices(found);
  },

  /**
   * A local model setup picked, with a context the tool definitions fit in (an Ollama model
   * gets a copy with `num_ctx` set).
   * @param {string} endpoint @param {string} model
   */
  prepareLocal(endpoint, model) {
    return prepareLocalModel(parentFetch, endpoint, model, { timeout });
  },

  /** @param {() => void} listener */
  addListener(listener) {
    listeners.add(listener);
  },

  /** @param {() => void} listener */
  removeListener(listener) {
    listeners.delete(listener);
  },
};
