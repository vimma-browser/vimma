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
// one the bench measures. Each conversation keeps its transcript (core agent-chat.mjs), built
// from the loop's events and the gate's events for its connection, which the chat window
// (ui/agent-chat.mjs) draws. Each conversation is also kept across restarts (B15, Behaviour
// 19-23): its messages, the agent's replies and Vimma's own task summaries, never page text or
// tool output, encrypted in its own file (AgentStore.sys.mjs). A reopened or cleared one sends the
// model only those. Until the feature is finished its pref keeps it off.

import { Budget } from "../core/agent-budget.mjs";
import { CLIS, DEFAULT_MAX_MINUTES } from "../core/agent-cli.mjs";
import { Transcript, isLocalEndpoint, needsKey, noticeTarget } from "../core/agent-chat.mjs";
import { startTask } from "../core/agent-loop.mjs";
import { checkEndpoint } from "../core/agent-providers.mjs";
import {
  expired,
  hostsOf,
  modelMessages,
  restoredEntries,
  stoppedAtCheckpoint,
  storedRecord,
  taskSummary,
} from "../core/agent-store.mjs";
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
  forgetListedSites,
  runAgentCommand,
} from "../ctl/agent-commands.mjs";
import { AgentGate } from "../ctl/AgentGate.sys.mjs";
import { AGENT_CONFIG_TOPIC, McpHost } from "../host/mcp-ops.mjs";
import { AgentCli, CLI_FEATURE_PREF } from "./AgentCli.sys.mjs";
import { AgentKeys } from "./AgentKeys.sys.mjs";
import { AgentStore } from "./AgentStore.sys.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  // Lazily: the control socket imports the host, which loads this module on demand.
  VimmaControl: "chrome://browser/content/vimma/ctl/VimmaControl.sys.mjs",
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
 *   last: { outcome: string, error?: string } | null, transcript: Transcript,
 *   confirmed: string | null, granted: boolean, uid: string, created: number, used: number,
 *   stored: StoredEntry[], taskStart: number, urls: unknown[],
 *   cli: { model: string, tools: string[] | null } | null, costNoted: boolean }} Conversation
 *   `confirmed`: the endpoint (or `cli:<id>`, core noticeTarget) whose notice of what leaves the
 *   machine the user answered y to (Behaviour 5); `cli`: what an agent CLI reported when its
 *   last run started, for the header (builtin-agent-cli C7); `costNoted`: the transcript said
 *   that max_cost does not apply to its CLI (C13); `granted`: whether it had a grant at the last change, for the transcript's
 *   notice when that changes; `uid`: its file's name; `stored`: what its file holds (B15);
 *   `taskStart`: where the running task's transcript entries begin; `urls`: the pages its task
 *   was asked about, for the summary's hosts
 * @typedef {import("../core/agent-store.mjs").StoredEntry} StoredEntry
 */

/**
 * Unfinished: off until the window has its key (delivery 6; builtin-agent B22; CONTRIBUTING.md,
 * "Unfinished features").
 */
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
/** Saves under way, which `flush` waits for. @type {Set<Promise<void>>} */
const saves = new Set();
/** @type {Promise<void> | null} the stored conversations' first read, once started */
let restoring = null;
/** `keep_days` runs at start and then once a day (Behaviour 20). */
const PRUNE_EVERY_MS = 86_400_000;

function changed() {
  for (const c of conversations.values()) {
    const granted = AgentGate.grants().some((g) => g.conn === c.conn);
    if (granted !== c.granted) {
      c.granted = granted;
      c.transcript.notice(
        granted
          ? "granted: this conversation may use the agent workspace until it is stopped; " +
              "sending a form or paying still asks"
          : "grant ended: each step asks until you send with Enter",
      );
    }
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch (e) {
      console.error("vimma agent chat:", e);
    }
  }
}

/**
 * The gate's events about a conversation's connection go into its transcript (a step's words
 * and outcome, a checkpoint); every gate change may end or make a grant, so the window redraws.
 * @param {import("../ctl/AgentGate.sys.mjs").GateEvent} [event]
 */
function onGate(event) {
  if (event && event.kind !== "notice") {
    const q = event.kind === "ran" ? event : event.question;
    const c = [...conversations.values()].find((x) => x.conn === q.conn);
    const what = /** @type {Record<string, any>} */ (q.what);
    if (c?.task) c.urls.push(what?.url, what?.current);
    const e = {
      kind: event.kind,
      tool: q.tool,
      what: /** @type {Record<string, any>} */ (q.what),
      ...(event.kind === "answered" ? { answer: event.answer } : {}),
    };
    // An agent CLI's steps are the gate's alone: no loop's call starts them (builtin-agent-cli C8).
    if (c?.provider.kind === "cli") c.transcript.cliGate(e);
    else c?.transcript.gate(e);
  }
  changed();
}
let gateListening = false;

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
 * Writes conversation `c`'s file, encrypted, once it holds a message: what it stored, never its
 * tool results (B15). A save that fails (no keyring, a full disk) leaves it in memory only.
 * @param {Conversation} c
 */
function persist(c) {
  // A deleted conversation's task may still end after its file went: nothing comes back.
  if (!c.stored.length || conversations.get(c.id) !== c) return;
  const save = AgentStore.save(storedRecord(c)).catch((e) => {
    // Only the error's name: its text could carry what was being written.
    console.error("vimma agent: a conversation could not be stored", /** @type {any} */ (e)?.name);
  });
  saves.add(save);
  save.finally(() => saves.delete(save));
}

/**
 * A conversation's in-memory parts, on a connection of its own that starts without a grant (B5):
 * a new one, or a stored one read back.
 * @param {{ provider: AgentProviderConfig, title: string, uid?: string, created?: number,
 *   used?: number, stored?: StoredEntry[] }} o
 * @returns {Conversation}
 */
function make(o) {
  const id = nextId++;
  const now = Date.now();
  const stored = o.stored ?? [];
  /** @type {Conversation} */
  const c = {
    id,
    conn: `${BUILTIN_CONN_PREFIX}${id}`,
    title: o.title,
    provider: o.provider,
    state: {},
    // A stored conversation starts with a clean context: what it stored, no page (Behaviour 21).
    messages: modelMessages(stored),
    task: null,
    starting: false,
    stopped: false,
    budget: null,
    done: null,
    last: null,
    transcript: new Transcript(),
    confirmed: null,
    granted: false,
    uid: o.uid ?? Services.uuid.generateUUID().toString().slice(1, -1),
    created: o.created ?? now,
    used: o.used ?? now,
    stored,
    taskStart: 0,
    urls: [],
    cli: null,
    costNoted: false,
  };
  for (const e of restoredEntries(stored)) {
    if (e.kind === "user") c.transcript.user(e.text);
    else if (e.kind === "agent") c.transcript.task({ type: "reply", text: e.text });
    else c.transcript.notice(e.text);
  }
  if (!gateListening) {
    gateListening = true;
    AgentGate.addListener(onGate);
  }
  builtinHello(c.conn, c.state, {
    client: builtinLabel(c.title || "New conversation"),
    via: `${o.provider.name} · ${o.provider.model || o.provider.cli || ""}`,
  });
  conversations.set(id, c);
  return c;
}

/**
 * The conversation leaves memory with its connection, its grant and its claim on its tabs.
 * @param {Conversation} c
 */
function drop(c) {
  AgentChat.stop(c.id);
  AgentGate.disconnect(c.conn);
  forgetAgentConnection(c.conn);
  AgentTabOwners.forget(c.conn);
  conversations.delete(c.id);
}

/**
 * The summary Vimma stores for a task that ended (B15): outcome, counts and hosts.
 * @param {Conversation} c @param {string} outcome
 */
function summarize(c, outcome) {
  const status = c.budget?.status();
  const text = taskSummary({
    outcome,
    checkpoint: stoppedAtCheckpoint(c.transcript.entries.slice(c.taskStart)),
    steps: status?.steps ?? 0,
    tokens: status?.tokens ?? 0,
    estimated: status?.estimated ?? false,
    hosts: hostsOf(c.urls),
  });
  c.stored.push({ kind: "summary", text });
  c.used = Date.now();
  persist(c);
}

/** `keep_days` in force when it last ran, so a changed value runs it again. */
let prunedWith = /** @type {number | null | undefined} */ (undefined);
let pruneTimer = /** @type {any} */ (null);

/** config.toml was read: `keep_days` runs at start, when it changes, and once a day. */
function onConfig() {
  if (!AgentChat.enabled) return;
  const keepDays = config()?.keepDays ?? null;
  if (pruneTimer === null) {
    pruneTimer = lazy.setInterval(() => AgentChat.prune(), PRUNE_EVERY_MS);
  }
  if (keepDays === prunedWith) return;
  prunedWith = keepDays;
  AgentChat.prune();
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
 * Why a task may not go to `provider` now, or null: an endpoint that config.toml's rules
 * refuse, or an agent CLI while that feature is off or with `local_only`, since Vimma cannot
 * see where a CLI sends what it reads (builtin-agent-cli Behaviour 6, C11).
 * @param {AgentProviderConfig} provider @param {boolean} localOnly
 * @returns {string | null}
 */
function providerRefusal(provider, localOnly) {
  if (provider.kind !== "cli") return checkEndpoint(provider.endpoint, { localOnly });
  if (!AgentCli.enabled) return `agent CLIs are unfinished and off (${CLI_FEATURE_PREF})`;
  if (!Object.hasOwn(CLIS, provider.cli ?? "")) return "this provider names no supported CLI";
  if (localOnly) return "an agent CLI may send page text off this machine ([agent] local_only)";
  return null;
}

/**
 * An agent CLI's run of conversation `c` (builtin-agent-cli Behaviour 7-16): its stream's
 * replies and own-tool steps go into the transcript, its steps in the browser come from the
 * gate (onGate), and what it reported at its start is kept for the header.
 * @param {Conversation} c @param {string} text @param {Budget} budget
 */
function startCli(c, text, budget) {
  const cli = CLIS[c.provider.cli ?? ""];
  if (cli && !c.costNoted) {
    c.costNoted = true;
    c.transcript.notice(
      `max_cost does not apply to ${cli.id}: the cost it reports is its own estimate`,
    );
  }
  const handle = AgentCli.start({
    provider: c.provider,
    conn: c.conn,
    state: c.state,
    text,
    // What is stored, never this session's tool results: the CLI keeps no session (C5).
    messages: modelMessages(c.stored.slice(0, -1)),
    budget,
    onEvent: (e) => {
      if (e.type === "init") {
        c.cli = { model: e.model, tools: e.tools };
        c.transcript.notice(
          `run started: ${cli?.id} ${e.version} · ${e.model || "its default model"} · ` +
            `its own tools: ${e.tools.length ? e.tools.join(", ") : "none"}`,
        );
      } else if (e.type === "reply") c.transcript.task({ type: "reply", text: e.text });
      else if (e.type === "own-tool") c.transcript.ownTool(e.id, e.text);
      else if (e.type === "own-tool-refused") c.transcript.ownToolRefused(e.id);
      changed();
    },
  });
  return {
    stop: handle.stop,
    steer: handle.steer,
    done: handle.done.then((result) => {
      // A run that was stopped or failed had no result to report them in.
      if (!budget.tokensReported && (result.outcome === "done" || result.outcome === "budget")) {
        c.transcript.notice(`tokens not reported by ${cli?.id}`);
      }
      // The CLI's context is not Vimma's: only the message and its reply join the
      // conversation a model provider would be sent after a change of provider.
      /** @type {import("../core/agent-providers.mjs").ChatMessage[]} */
      const messages = [...c.messages, { role: "user", text }];
      if (result.reply) messages.push({ role: "assistant", text: result.reply, toolCalls: [] });
      return { ...result, messages };
    }),
  };
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
  const { name, kind, endpoint, model, cli } = c.provider;
  return {
    id: c.id,
    conn: c.conn,
    title: c.title,
    provider: { name, kind, endpoint, model, ...(cli ? { cli } : {}) },
    cli: c.cli,
    running: isRunning(c),
    granted: AgentGate.grants().some((g) => g.conn === c.conn),
    budget: c.budget?.status() ?? null,
    last: c.last,
    uid: c.uid,
    used: c.used,
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
    const c = make({ provider, title });
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
      const refused = providerRefusal(c.provider, localOnly);
      if (refused) return { refused };
      // Behaviour 5 is the window's question, and no other caller may skip it.
      if (this.needsNotice(id)) {
        return { refused: `nothing is sent to ${c.provider.name} before you say y to its notice` };
      }
    }
    if (!c.title) {
      c.title = titleOf(text);
      AgentGate.relabel(c.conn, builtinLabel(c.title));
    }
    /** The send's effect on the grant: made by Enter, ended by ctrl+Enter (B18). */
    const applyGrant = () => (ask ? AgentGate.endGrant(c.conn) : AgentGate.grantConnection(c.conn));
    if (c.task && !c.stopped) {
      c.transcript.user(text, { during: true });
      c.stored.push({ kind: "user", text });
      c.used = Date.now();
      persist(c);
      applyGrant();
      c.task.steer(text);
      changed();
      return { steered: true };
    }
    // Held from here, before the awaits, so two sends cannot both take the last place.
    c.starting = true;
    changed();
    let key;
    try {
      // An agent CLI keeps its own login.
      key = c.provider.kind === "cli" ? "" : await keyFor(c.provider);
    } catch (e) {
      c.starting = false;
      changed();
      console.error(
        "vimma agent: the provider's key could not be read",
        /** @type {any} */ (e)?.name,
      );
      return { refused: `the key of ${c.provider.name} could not be read` };
    }
    if (!conversations.has(id) || !c.starting) return { refused: "the conversation was stopped" };
    // A provider that needs a key gets no request without one (security.md M46).
    if (!key && needsKey(c.provider)) {
      c.starting = false;
      changed();
      return { refused: `${c.provider.name} has no API key; m in the window sets one` };
    }
    c.transcript.user(text);
    c.stored.push({ kind: "user", text });
    c.used = Date.now();
    c.taskStart = c.transcript.entries.length;
    c.urls = [];
    persist(c);
    // Only now, so a send that starts no task leaves no grant behind.
    applyGrant();
    const limits = config() ?? AGENT_DEFAULTS;
    const isCli = c.provider.kind === "cli";
    const budget = new Budget(
      { maxSteps: limits.maxSteps, maxTokens: limits.maxTokens, maxCost: limits.maxCost },
      c.provider,
      isCli
        ? {
            cli: c.provider.cli ?? "",
            maxMinutes: c.provider.maxMinutes ?? DEFAULT_MAX_MINUTES,
          }
        : undefined,
    );
    const handle = isCli
      ? startCli(c, text, budget)
      : startTask({
          // A model provider: an agent CLI's kind went to startCli.
          provider: /** @type {import("../core/agent-providers.mjs").Provider} */ (c.provider),
          fetch: parentFetch,
          key,
          system: AGENT_INSTRUCTIONS,
          tools: agentTools({ vision: c.provider.vision }),
          messages: [...c.messages, { role: "user", text }],
          runTool: (name, args, opts) => runTool(c, name, args, opts),
          budget,
          localOnly,
          keepResults: config()?.keepResults ?? null,
          onEvent: (e) => {
            c.transcript.task(e);
            changed();
          },
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
        // Only the task's final reply is kept, not the text that came with its tool calls,
        // which most often restates the page it was reading.
        if (result.reply) c.stored.push({ kind: "agent", text: result.reply });
        summarize(c, result.outcome);
        c.transcript.end(result);
        changed();
        return result;
      },
      (e) => {
        if (c.task === handle) c.task = null;
        c.last = { outcome: "error", error: String(e?.message ?? e) };
        summarize(c, "error");
        c.transcript.end(c.last);
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
    // An agent CLI's connection closes first, before its process is signalled, so nothing it
    // sends after the stop reaches the browser (docs/specs/builtin-agent-cli.md C9).
    lazy.VimmaControl.revokeTickets(c.conn);
    c.task?.stop();
    for (const withdraw of [...(c.state.cancels?.values() ?? [])]) withdraw();
    AgentGate.endGrant(c.conn);
    changed();
  },

  /**
   * A one-time ticket that lets an agent CLI's `vimma-ctl mcp` act as this conversation
   * (docs/specs/builtin-agent-cli.md C1, C3), until the conversation stops or is deleted.
   * @param {number} id @param {string} label  the CLI's name, for the notice of a refused
   *   second connection
   * @returns {Promise<{ ticket: string, port: number }>}
   */
  issueTicket(id, label) {
    const c = conversation(id);
    return lazy.VimmaControl.issueTicket({ conn: c.conn, state: c.state, label });
  },

  /** `ctrl+b shift+a` with no question waiting: every running task stops (Behaviour 16). */
  stopAll() {
    for (const c of conversations.values()) if (isRunning(c)) this.stop(c.id);
  },

  /**
   * `d` (Behaviour 19): the conversation goes, with its file, its connection, its grant and its
   * claim on its tabs.
   * @param {number} id
   * @returns {Promise<void>} settled once its file is removed
   */
  delete(id) {
    const c = conversations.get(id);
    if (!c) return Promise.resolve();
    drop(c);
    changed();
    return AgentStore.remove(c.uid).catch((e) =>
      console.error("vimma agent: a conversation's file could not be removed", e?.name),
    );
  },

  /**
   * `:agent forget all` (Behaviour 23): running tasks stop, and every conversation goes with
   * every file of the store, those it could not read included.
   */
  async forgetAll() {
    for (const c of [...conversations.values()]) drop(c);
    changed();
    await AgentStore.removeAll();
  },

  /**
   * The stored conversations, read once (Behaviour 19-21): each starts with a clean context and
   * no grant. Settled when read, or when the store could not be read.
   * @returns {Promise<void>}
   */
  restore() {
    restoring ??= (async () => {
      if (!this.enabled) return;
      try {
        const known = new Set([...conversations.values()].map((c) => c.uid));
        for (const r of await AgentStore.loadAll()) {
          if (known.has(r.id)) continue;
          make({
            provider: /** @type {AgentProviderConfig} */ (r.provider),
            title: r.title,
            uid: r.id,
            created: r.created,
            used: r.used,
            stored: r.entries,
          });
        }
      } catch (e) {
        console.error("vimma agent: the stored conversations could not be read", e);
      }
      changed();
    })();
    return restoring;
  },

  /** Whether the stored conversations were read, or are being read. */
  get restored() {
    return restoring !== null;
  },

  /**
   * What a restart does to the conversations in memory, which tests use to read the files
   * again: every one is dropped, its file kept.
   */
  reset() {
    for (const c of [...conversations.values()]) drop(c);
    restoring = null;
    changed();
  },

  /**
   * `keep_days` (Behaviour 20): conversations not used for that many days go, files and all.
   * A conversation's file is written whenever it is used, so its time is its last use.
   * @returns {Promise<void>}
   */
  async prune() {
    if (!this.enabled) return;
    // After a read under way, so a conversation whose file goes is not read back into memory.
    await restoring;
    const keepDays = config()?.keepDays ?? null;
    if (keepDays === null) return;
    const now = Date.now();
    let removed;
    try {
      removed = new Set(await AgentStore.prune((modified) => expired(modified, now, keepDays)));
    } catch (e) {
      console.error("vimma agent: keep_days could not run", e);
      return;
    }
    for (const c of [...conversations.values()]) {
      if (removed.has(c.uid) && !isRunning(c)) drop(c);
    }
    if (removed.size) changed();
  },

  /** Settled once every save under way is written or has failed. */
  async flush() {
    await Promise.allSettled([...saves]);
  },

  /** @param {number} id */
  get(id) {
    return view(conversation(id));
  },

  /**
   * What the window draws of a conversation: its transcript, read only.
   * @param {number} id
   * @returns {Readonly<Transcript>}
   */
  transcript(id) {
    return conversation(id).transcript;
  },

  /**
   * The model picker's choice (Behaviour 7): the conversation's next task goes to `provider`.
   * Refused while a task runs, so a task never changes where its page text goes.
   * @param {number} id @param {AgentProviderConfig} provider
   * @returns {string | null} why not
   */
  setProvider(id, provider) {
    const c = conversation(id);
    if (isRunning(c)) return "a task is running; s stops it";
    const refused = providerRefusal(provider, config()?.localOnly ?? false);
    if (refused) return refused;
    c.provider = provider;
    c.cli = null;
    AgentGate.relabel(c.conn, builtinLabel(c.title || "New conversation"));
    c.transcript.notice(`model: ${provider.name} · ${provider.model || provider.cli || ""}`);
    persist(c);
    changed();
    return null;
  },

  /**
   * Whether the next task must first say what leaves the machine (Behaviour 5): its provider
   * is off this machine and no y to it was given for this conversation and endpoint.
   * @param {number} id
   */
  needsNotice(id) {
    const c = conversation(id);
    // An agent CLI is never local: Vimma cannot see where it sends (builtin-agent-cli C11).
    const local = c.provider.kind !== "cli" && isLocalEndpoint(c.provider.endpoint);
    return !local && c.confirmed !== noticeTarget(c.provider);
  },

  /**
   * `C`, `:agent clear` (Behaviour 22): the model is sent only the messages, replies and task
   * summaries from now on, not the pages read before, as a reopened conversation is. Refused
   * while a task runs.
   * @param {number} id
   * @returns {string | null} why not
   */
  clear(id) {
    const c = conversation(id);
    if (isRunning(c)) return "a task is running; s stops it";
    c.messages = modelMessages(c.stored);
    forgetListedSites(c.conn);
    c.transcript.notice("context cleared: earlier page reads are no longer sent to the model");
    changed();
    return null;
  },

  /**
   * A y to Behaviour 5's notice: this conversation may send to the endpoint it named, or to
   * the agent CLI it named (`cli:<id>`, core noticeTarget).
   * @param {number} id @param {string} target  as the notice named it
   */
  confirm(id, target) {
    const c = conversation(id);
    // Only for what the notice named: a provider changed while it was open is not.
    if (target === noticeTarget(c.provider)) c.confirmed = target;
  },

  /**
   * A tab moved to the agent workspace for this conversation (Behaviour 17): it is the
   * conversation's from now on, and the transcript says so.
   * @param {number} id @param {any} tab  the tab in the agent workspace
   * @param {string} title  as the transcript names it
   */
  give(id, tab, title) {
    const c = conversation(id);
    AgentTabOwners.give(tab, c.conn);
    c.transcript.notice(`you gave tab "${title}"`);
    changed();
  },

  /**
   * The conversation that owns `tab`, or null.
   * @param {any} tab
   */
  ownerOf(tab) {
    const conn = AgentTabOwners.ownerOf(tab);
    return [...conversations.values()].find((c) => c.conn === conn)?.id ?? null;
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

Services.obs.addObserver(onConfig, AGENT_CONFIG_TOPIC);
if (McpHost.agentConfig) onConfig();
