/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One bench run, and the pieces that stand in for the user: the grant a task sent with `Enter`
// makes (B18), given here by answering the connection's first question with `a`, and the `n`
// that answers every later question, which under that grant only a checkpoint asks.

import { parseArgs as parseNodeArgs } from "node:util";
import { Budget } from "../../packages/vimma-core/src/agent-budget.mjs";
import { startTask } from "../../packages/vimma-core/src/agent-loop.mjs";
import { taskText } from "./lists.mjs";
import { isUserDenial, scoreRun } from "./score.mjs";
import { timedFetch } from "./breakdown.mjs";

/**
 * @typedef {import("../../packages/vimma-core/src/agent-loop.mjs").RunTool} RunTool
 * @typedef {{ name: string, args?: any, error?: boolean, denied?: boolean, refused?: string,
 *   said?: string, ms?: number }} CallLog
 */

/**
 * Runs one list through vimma-core's loop and scores what reached the shop.
 * @param {{ list: import("./score.mjs").ShoppingList,
 *   shop: { base: string, reset(): void, record(): import("./score.mjs").ShopRecord },
 *   provider: import("../../packages/vimma-core/src/agent-providers.mjs").Provider,
 *   fetch: import("../../packages/vimma-core/src/agent-providers.mjs").Fetch, key: string,
 *   system: string, tools: import("../../packages/vimma-core/src/agent-providers.mjs").ToolDef[],
 *   runTool: RunTool, limits: Partial<import("../../packages/vimma-core/src/agent-budget.mjs").Limits>,
 *   timeoutMs: number, settleMs?: number }} o
 *   `settleMs`: time for the requests a page's script sends after the last click to arrive
 */
export async function runOne(o) {
  o.shop.reset();
  const budget = new Budget(o.limits);
  /** @type {CallLog[]} */
  const calls = [];
  /** @type {import("./breakdown.mjs").Turn[]} */
  const turns = [];
  let denials = 0;
  let callStart = 0;
  const started = Date.now();
  const task = startTask({
    provider: o.provider,
    fetch: timedFetch(o.fetch, (t) => turns.push(t)),
    key: o.key,
    system: o.system,
    tools: o.tools,
    messages: [{ role: "user", text: taskText(o.list, o.shop.base) }],
    runTool: o.runTool,
    budget,
    onEvent: (e) => {
      if (e.type === "usage") {
        const turn = turns.at(-1);
        if (turn) Object.assign(turn, { input: e.usage.input, output: e.usage.output });
      } else if (e.type === "call") {
        callStart = performance.now();
      } else if (e.type === "result") {
        const denied = isUserDenial(e.result);
        if (denied) denials++;
        // The start of each result, to read back why a model did what it did.
        const said = e.result.content
          .flatMap((c) => (c.type === "text" ? [c.text] : []))
          .join("\n")
          .slice(0, 1500);
        const ms = Math.round(performance.now() - callStart);
        calls.push({
          name: e.call.name,
          args: e.call.args,
          error: e.result.isError,
          denied,
          said,
          ms,
        });
      } else if (e.type === "refused") {
        calls.push({ name: e.call.name, args: e.call.args, refused: e.reason, ms: 0 });
      }
    },
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    task.stop();
  }, o.timeoutMs);
  const result = await task.done;
  clearTimeout(timer);
  const wallMs = Date.now() - started;
  if (o.settleMs) await new Promise((r) => setTimeout(r, o.settleMs));
  const score = scoreRun(o.list, o.shop.record(), {
    outcome: timedOut ? "timeout" : result.outcome,
    steps: budget.steps,
    input: budget.input,
    output: budget.output,
    estimated: budget.estimated,
    wallMs,
    denials,
  });
  return { ...score, calls, turns, reply: result.reply ?? "", error: result.error ?? null };
}

/**
 * Presses `key` while a tool call has waited longer than a question takes to arm, again every
 * `everyMs`, until the call returns. A key with no question waiting lands on the main
 * workspace's blank page, where `n` does nothing.
 * @param {{ sendKeys: (keys: string) => Promise<void>, key?: string, afterMs?: number,
 *   everyMs?: number, clock?: () => number }} o
 */
export function answerer({
  sendKeys,
  key = "n",
  afterMs = 1500,
  everyMs = 1000,
  clock = Date.now,
}) {
  /** @type {Set<{ at: number }>} */
  const inflight = new Set();
  let last = -Infinity;
  return {
    /** @param {RunTool} run @returns {RunTool} */
    wrap: (run) => async (name, args, opts) => {
      const t = { at: clock() };
      inflight.add(t);
      try {
        return await run(name, args, opts);
      } finally {
        inflight.delete(t);
      }
    },
    async tick() {
      if (inflight.size === 0) return;
      const now = clock();
      const oldest = Math.min(...[...inflight].map((t) => t.at));
      if (now - oldest < afterMs || now - last < everyMs) return;
      last = now;
      await sendKeys(key);
    },
  };
}

/**
 * The run's grant: the connection's first call asks, and `a` allows it until the connection
 * ends (mcp-session-grants), as sending a task with `Enter` will (B18). Keys count only once the
 * question is armed, so `a` is pressed after each wait until the call returns.
 * @param {{ call: () => Promise<{ isError?: boolean, content?: any[] }>,
 *   sendKeys: (keys: string) => Promise<void>, sleep?: (ms: number) => Promise<void>,
 *   tries?: number, waitMs?: number }} o
 */
export async function grantSession({
  call,
  sendKeys,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  tries = 10,
  waitMs = 1200,
}) {
  /** @type {{ r?: any, e?: unknown } | null} */
  let settled = null;
  call().then(
    (r) => (settled = { r }),
    (e) => (settled = { e }),
  );
  for (let i = 0; i < tries && !settled; i++) {
    await sleep(waitMs);
    if (settled) break;
    await sendKeys("a");
  }
  await sleep(0);
  const s = /** @type {{ r?: any, e?: unknown } | null} */ (settled);
  if (!s) throw new Error("no grant: the first call's question was not answered");
  if (s.e) throw s.e;
  if (s.r?.isError) {
    const text = (s.r.content ?? []).map((/** @type {any} */ c) => c.text ?? "").join(" ");
    throw new Error(`no grant: ${text}`);
  }
  return s.r;
}

const PROVIDERS = ["scripted", "openai", "anthropic"];
const ENDPOINTS = /** @type {Record<string, string>} */ ({
  openai: "http://127.0.0.1:11434/v1",
  anthropic: "https://api.anthropic.com",
});

/**
 * `npm run agent-bench -- …`'s options.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: {
      provider: { type: "string", default: "scripted" },
      endpoint: { type: "string" },
      model: { type: "string" },
      "key-env": { type: "string" },
      vision: { type: "boolean", default: false },
      "num-ctx": { type: "string" },
      lists: { type: "string" },
      runs: { type: "string", default: "1" },
      "max-steps": { type: "string" },
      "max-tokens": { type: "string" },
      "timeout-minutes": { type: "string", default: "20" },
      build: { type: "string" },
      artifact: { type: "boolean", default: false },
      "vimma-ctl": { type: "string" },
      out: { type: "string" },
      check: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      shots: { type: "string" },
      floor: { type: "string", default: "search" },
      "pace-ms": { type: "string", default: "0" },
      help: { type: "boolean", default: false },
    },
  });
  const provider = /** @type {string} */ (values.provider);
  if (!PROVIDERS.includes(provider))
    throw new Error(`--provider must be one of ${PROVIDERS.join(", ")}, not ${provider}`);
  if (provider !== "scripted" && !values.model)
    throw new Error(`--provider ${provider} needs --model`);
  const floor = /** @type {string} */ (values.floor);
  if (floor !== "search" && floor !== "product")
    throw new Error(`--floor must be search or product, not ${floor}`);
  const paceMs = Number(values["pace-ms"]);
  if (!Number.isInteger(paceMs) || paceMs < 0)
    throw new Error("--pace-ms must be a whole number of milliseconds, 0 or more");
  /** @param {string | undefined} v @param {string} name */
  const int = (v, name) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a whole number above 0`);
    return n;
  };
  return {
    provider,
    endpoint: values.endpoint ?? ENDPOINTS[provider] ?? null,
    model: values.model ?? null,
    keyEnv: values["key-env"] ?? null,
    vision: values.vision ?? false,
    numCtx: int(values["num-ctx"], "--num-ctx") ?? null,
    lists: values.lists ? values.lists.split(",").map((s) => s.trim()) : null,
    runs: /** @type {number} */ (int(values.runs, "--runs")),
    maxSteps: int(values["max-steps"], "--max-steps") ?? null,
    maxTokens: int(values["max-tokens"], "--max-tokens") ?? null,
    timeoutMinutes: /** @type {number} */ (int(values["timeout-minutes"], "--timeout-minutes")),
    build: values.build ?? null,
    artifact: values.artifact ?? false,
    vimmaCtl: values["vimma-ctl"] ?? null,
    out: values.out ?? null,
    check: values.check ?? false,
    keep: values.keep ?? false,
    shots: values.shots ?? null,
    floor: /** @type {"search" | "product"} */ (floor),
    paceMs,
    help: values.help ?? false,
  };
}
