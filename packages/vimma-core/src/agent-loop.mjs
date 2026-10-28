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

import { callModel } from "./agent-providers.mjs";

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
 *   | { type: "steer", text: string }} TaskEvent
 *   What the transcript shows as the task runs.
 * @typedef {{ outcome: "done" | "stopped" | "budget" | "error", messages: ChatMessage[],
 *   reply?: string, exceeded?: Exceeded, error?: string, after?: ToolCall | null }} TaskResult
 *   `after`: for a stopped task, the step that ran last (`stopped after "clicked …"`).
 */

const STOPPED = "Not run: the task was stopped.";
const OVER_BUDGET = "Not run: the task reached its budget.";

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
 *   onEvent?: (e: TaskEvent) => void }} opts
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
        messages,
        signal,
        localOnly: opts.localOnly,
      });
    } catch (e) {
      if (signal.aborted) return stopped();
      return { outcome: "error", messages, error: e instanceof Error ? e.message : String(e) };
    }
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
    for (const call of message.toolCalls) {
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
      const refused = checkToolCall(call, tools);
      if (refused) {
        emit({ type: "refused", call, reason: refused });
        results.push(notRun(call, `Not run: ${refused}.`));
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
    }
    if (signal.aborted) return stopped();
    if (exceeded) return { outcome: "budget", messages, exceeded };
  }
}
