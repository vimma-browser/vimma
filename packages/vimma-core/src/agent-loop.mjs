/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's model loop (docs/specs/builtin-agent.md B6, B10, Behaviour 15-18, 34):
// send the conversation to the model, run the tool calls it makes one at a time through the
// caller's tool runner, give it the results, and repeat until it replies without a tool call,
// is stopped, or reaches its budget. It takes `fetch` and the runner as arguments and imports
// nothing from Firefox, so the bench runs this same loop in Node against `vimma-ctl mcp` and
// the browser runs it against its agent commands. Everything that keeps the agent safe (the
// gate, grants, checkpoints, confinement) is the runner's side; the loop only bounds the task.

import { ProviderError, callModel, isLocalEndpoint } from "./agent-providers.mjs";
import { isFinalRefusal } from "./agent-results.mjs";
import { UNTRUSTED_FROM } from "./agent.mjs";

/**
 * @typedef {import("./agent-providers.mjs").ChatMessage} ChatMessage
 * @typedef {import("./agent-providers.mjs").ToolCall} ToolCall
 * @typedef {import("./agent-providers.mjs").ToolResult} ToolResult
 * @typedef {import("./agent-providers.mjs").ToolContent} ToolContent
 * @typedef {import("./agent-providers.mjs").ToolDef} ToolDef
 * @typedef {import("./agent-providers.mjs").Provider} Provider
 * @typedef {import("./agent-providers.mjs").Fetch} Fetch
 * @typedef {import("./agent-providers.mjs").Usage} Usage
 * @typedef {import("./agent-budget.mjs").Budget} Budget
 * @typedef {import("./agent-budget.mjs").Exceeded} Exceeded
 *
 * @typedef {(name: string, args: Record<string, any>, opts: { signal: AbortSignal })
 *   => Promise<{ content?: ToolContent[], isError?: boolean }>} RunTool
 *   One tool call, answered as MCP's CallToolResult: through the gate, so it may wait for the
 *   user's answer and come back denied (`isError`).
 * @typedef {{ type: "usage", usage: Usage }
 *   | { type: "reply", text: string }
 *   | { type: "call", call: ToolCall }
 *   | { type: "refused", call: ToolCall, reason: string }
 *   | { type: "result", call: ToolCall, result: ToolResult }
 *   | { type: "steer", text: string }
 *   | { type: "server-error", error: string }} TaskEvent
 *   What the transcript shows as the task runs.
 * @typedef {{ outcome: "done" | "stopped" | "budget" | "error", messages: ChatMessage[],
 *   reply?: string, exceeded?: Exceeded, error?: string, after?: ToolCall | null }} TaskResult
 *   `after`: for a stopped task, the step that ran last (`stopped after "clicked …"`).
 */

const STOPPED = "Not run: the task was stopped.";
const OVER_BUDGET = "Not run: the task reached its budget.";
/**
 * The same call refused this many times in a row ends the task: a model that repeats a refused
 * call does not learn from the refusal (docs/agent-bench.md: one sent the same refused call 18
 * times), and each repeat spends a step and a turn's tokens. Only refusals the same call meets
 * again count (isFinalRefusal); waiting for a page to load is not a repeat.
 */
export const REPEAT_LIMIT = 3;
/**
 * Server errors in a row that end the task. One ends only the model's turn: a local server
 * aborts a turn now and then (Ollama's `token repeat limit reached`) and the next turn may work.
 */
export const SERVER_ERRORS = 3;

/**
 * How many of the latest tool results a request to a hosted provider carries whole, when
 * `[agent] keep_results` is not set (docs/specs/agent-speed.md S5). Older ones keep their first
 * line. Hosted input tokens cost money, and a block left out costs seconds there.
 */
export const KEEP_RESULTS = 6;
/**
 * The same for a provider on this machine. Each block left out makes a local server read the
 * request again from the first changed result, about 120 s on a CPU-bound model
 * (docs/agent-bench.md), so it prunes rarely: a ten-item list (about 36 results) never reaches
 * a block, and a longer task's context still stops growing.
 */
export const KEEP_RESULTS_LOCAL = 20;

/**
 * The `keepResults` a task runs with: `[agent] keep_results` when set, else by where the
 * provider runs.
 * @param {Provider} provider @param {number | null | undefined} configured
 */
export function keepResultsFor(provider, configured) {
  if (configured != null) return configured;
  return isLocalEndpoint(provider.endpoint) ? KEEP_RESULTS_LOCAL : KEEP_RESULTS;
}
/** What replaces the rest of a left-out result. Vimma's words, never the page's. */
export const LEFT_OUT =
  "(Vimma left the rest of this older result out of the conversation to save space. Call the " +
  "tool again to see the page as it is now.)";

/**
 * The conversation as a request sends it: the body of every tool result older than the last
 * `keep` to `2 * keep - 1` results is left out, keeping its first line (for a page, Vimma's line
 * with its URL and title, outside the untrusted-content delimiters) and LEFT_OUT. Results leave
 * a whole block of `keep` at a time, so a request repeats the one before it and only adds to it
 * until the next block leaves, and a provider's prompt cache (Anthropic's `cache_control`,
 * Ollama's slot) keeps the prefix in between; pruning every turn would make it read the whole
 * conversation again each turn. Refusals and the user's no (`isError`) stay whole: they are
 * Vimma's short text, and what the model was refused is what it must not try again. The user's
 * messages and the agent's replies are never touched, nor a result no longer than its left-out form (one line already, or
 * a short step's report).
 * `keep` 0 leaves nothing out.
 * @param {ChatMessage[]} messages @param {number} keep
 * @returns {ChatMessage[]}
 */
export function pruneResults(messages, keep) {
  if (!(keep > 0)) return messages;
  let total = 0;
  for (const m of messages) if (m.role === "tool") total += m.results.length;
  const leave = total < keep ? 0 : Math.floor((total - keep) / keep) * keep;
  if (leave === 0) return messages;
  let seen = 0;
  return messages.map((m) => {
    if (m.role !== "tool" || seen >= leave) {
      if (m.role === "tool") seen += m.results.length;
      return m;
    }
    const results = m.results.map((r) => (seen++ < leave ? leaveOut(r) : r));
    return { role: "tool", results };
  });
}

/** @param {ToolResult} r @returns {ToolResult} */
function leaveOut(r) {
  if (r.isError) return r;
  const first = r.content.find((c) => c.type === "text");
  // A page's line is kept whole, even when its title breaks it, so the title never loses the
  // warning that follows it.
  const line =
    first?.type !== "text"
      ? ""
      : first.text.startsWith(UNTRUSTED_FROM)
        ? first.text
        : first.text.split("\n", 1)[0];
  const text = line ? `${line}\n${LEFT_OUT}` : LEFT_OUT;
  const size = r.content.reduce(
    (n, c) => n + (c.type === "text" ? c.text.length : c.data.length),
    0,
  );
  if (size <= text.length) return r;
  return { ...r, content: [{ type: "text", text }] };
}

/** @type {Record<string, (v: unknown) => boolean>} */
const TYPES = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
};

/**
 * Why a call cannot run, or null. Only what a model gets wrong most (a tool that does not
 * exist, arguments that are not an object, a missing or unknown argument, a wrong type at the
 * top level); the runner checks the rest, as it does for MCP agents. Refusing these here gives
 * the model a plain reason and spends no gate question on them.
 * @param {ToolCall} call @param {ToolDef[]} tools
 * @returns {string | null}
 */
export function checkToolCall(call, tools) {
  if (call.error) return call.error;
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return `there is no tool named ${JSON.stringify(call.name)}`;
  const args = /** @type {Record<string, any>} */ (call.args);
  const schema = tool.inputSchema;
  const props = schema.properties ?? {};
  for (const name of schema.required ?? [])
    if (!(name in args)) return `${call.name} needs ${JSON.stringify(name)}`;
  for (const [name, value] of Object.entries(args)) {
    const prop = props[name];
    if (!prop) {
      if (schema.additionalProperties === false)
        return `${call.name} takes no ${JSON.stringify(name)}`;
      continue;
    }
    const is = TYPES[prop.type];
    if (is && !is(value)) {
      const article = /^[aeiou]/.test(prop.type) ? "an" : "a";
      return `${JSON.stringify(name)} must be ${article} ${prop.type}`;
    }
  }
  return null;
}

/**
 * The conversation as a reopened or cleared one sends it (Behaviour 21-22): the user's
 * messages (Vimma's task summaries among them) and the agent's replies, without tool calls,
 * tool results or the page text in them.
 * @param {ChatMessage[]} messages
 * @returns {ChatMessage[]}
 */
export function clearContext(messages) {
  return messages.flatMap(clearOne);
}

/** @param {ChatMessage} m @returns {ChatMessage[]} */
function clearOne(m) {
  if (m.role === "user") return [{ role: "user", text: m.text }];
  if (m.role === "assistant" && m.text) return [{ role: "assistant", text: m.text, toolCalls: [] }];
  return [];
}

/** @param {ToolCall} call @param {string} text @returns {ToolResult} */
const notRun = (call, text) => ({
  id: call.id,
  name: call.name,
  isError: true,
  content: [{ type: "text", text }],
});

/**
 * Starts one task: the model's turns until it replies without a tool call. `steer` adds a
 * message that reaches the model at its next turn (Behaviour 15); `stop` aborts the request
 * in flight and starts no further step, while a step already running finishes, since a click
 * that has happened cannot be undone (Behaviour 16).
 * @param {{ provider: Provider, fetch: Fetch, key: string, system: string, tools: ToolDef[],
 *   messages: ChatMessage[], runTool: RunTool, budget: Budget, localOnly?: boolean,
 *   keepResults?: number | null, onEvent?: (e: TaskEvent) => void }} opts
 *   `keepResults`: see pruneResults; keepResultsFor the provider when left out.
 * @returns {{ steer(text: string): void, stop(): void, done: Promise<TaskResult> }}
 */
export function startTask(opts) {
  const abort = new AbortController();
  /** @type {string[]} */
  const pending = [];
  // Started on a later microtask, so a `stop` right after `startTask` sends nothing.
  const done = Promise.resolve().then(() => run(opts, abort.signal, pending));
  return {
    steer: (text) => void pending.push(text),
    stop: () => abort.abort(),
    done,
  };
}

/**
 * @param {Parameters<typeof startTask>[0]} opts
 * @param {AbortSignal} signal @param {string[]} pending
 * @returns {Promise<TaskResult>}
 */
async function run(opts, signal, pending) {
  const { provider, budget, tools, runTool } = opts;
  const emit = opts.onEvent ?? (() => {});
  const messages = [...opts.messages];
  /** @type {ToolCall | null} */
  let after = null;
  const stopped = () => ({ outcome: /** @type {const} */ ("stopped"), messages, after });

  let serverErrors = 0;
  /** The last refused call as `name args`, and how many times in a row it was refused. */
  let refused = { key: "", times: 0 };
  /** @param {ToolCall} call @param {boolean} wasRefused @returns {boolean} the limit is reached */
  const count = (call, wasRefused) => {
    if (!wasRefused) {
      refused = { key: "", times: 0 };
      return false;
    }
    const key = `${call.name} ${JSON.stringify(call.args)}`;
    refused = { key, times: refused.key === key ? refused.times + 1 : 1 };
    return refused.times >= REPEAT_LIMIT;
  };

  const takePending = () => {
    for (const text of pending.splice(0)) {
      messages.push({ role: "user", text });
      emit({ type: "steer", text });
    }
  };

  for (;;) {
    if (signal.aborted) return stopped();
    const over = budget.exceeded();
    if (over) return { outcome: "budget", messages, exceeded: over };
    takePending();

    let reply;
    try {
      reply = await callModel(provider, {
        fetch: opts.fetch,
        key: opts.key,
        system: opts.system,
        tools,
        messages: pruneResults(messages, keepResultsFor(provider, opts.keepResults)),
        signal,
        localOnly: opts.localOnly,
      });
    } catch (e) {
      if (signal.aborted) return stopped();
      const error = e instanceof Error ? e.message : String(e);
      const server = e instanceof ProviderError && (e.status ?? 0) >= 500;
      if (!server || ++serverErrors >= SERVER_ERRORS) return { outcome: "error", messages, error };
      emit({ type: "server-error", error });
      // The failed turn produced nothing; the next one is told so. Only the status: the error's
      // body may quote the request, page text included, which must not come back as the user's.
      messages.push({
        role: "user",
        text: `(Vimma: the model server failed on your last turn with HTTP status ${
          /** @type {ProviderError} */ (e).status
        }. Go on with the task.)`,
      });
      continue;
    }
    serverErrors = 0;
    budget.addUsage(reply.usage);
    emit({ type: "usage", usage: reply.usage });
    const { message } = reply;
    messages.push(message);
    if (message.text) emit({ type: "reply", text: message.text });

    if (message.toolCalls.length === 0) {
      if (pending.length && !signal.aborted) continue;
      return { outcome: "done", messages, reply: message.text };
    }

    /** @type {ToolResult[]} */
    const results = [];
    messages.push({ role: "tool", results });
    /** @type {Exceeded | null} */
    let exceeded = budget.exceeded();
    /** @type {ToolCall | null} */
    let repeated = null;
    for (const call of message.toolCalls) {
      if (repeated) {
        results.push(notRun(call, STOPPED));
        continue;
      }
      if (signal.aborted) {
        results.push(notRun(call, STOPPED));
        continue;
      }
      exceeded ??= budget.exceeded();
      if (exceeded) {
        results.push(notRun(call, OVER_BUDGET));
        continue;
      }
      budget.step();
      const why = checkToolCall(call, tools);
      if (why) {
        emit({ type: "refused", call, reason: why });
        results.push(notRun(call, `Not run: ${why}.`));
        if (count(call, true)) repeated = call;
        continue;
      }
      emit({ type: "call", call });
      /** @type {ToolResult} */
      let result;
      try {
        const r = await runTool(call.name, /** @type {Record<string, any>} */ (call.args), {
          signal,
        });
        result = { id: call.id, name: call.name, isError: !!r?.isError, content: r?.content ?? [] };
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        result = notRun(call, `The tool failed: ${why}`);
      }
      after = call;
      results.push(result);
      emit({ type: "result", call, result });
      if (count(call, isFinalRefusal(result))) repeated = call;
    }
    if (signal.aborted) return stopped();
    if (repeated) {
      const error = `stopped: ${repeated.name} was refused ${REPEAT_LIMIT} times in a row with the same arguments`;
      return { outcome: "error", messages, error };
    }
    if (exceeded) return { outcome: "budget", messages, exceeded };
  }
}
