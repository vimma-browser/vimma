/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Where a run's time and tokens go: each model request timed and split into its parts (the tool
// definitions, the system text, the user's task, the model's earlier calls, earlier tool results
// and the results it has not seen yet), so that a change meant to make the agent faster or
// cheaper (docs/specs/agent-speed.md) is measured against the part it targets.

import type { Fetch } from "../../packages/vimma-core/src/agent/agent-providers.mjs";

/**
 * Characters of a request body. `latest`: tool results after the model's last turn, which a
 * server with a prompt cache still has to read; `results`: earlier ones, read again on every
 * turn by a server without one.
 */
export type Parts = {
  total: number;
  tools: number;
  system: number;
  task: number;
  calls: number;
  results: number;
  latest: number;
};
export type Turn = { ms: number; parts: Parts; input?: number; output?: number };

function textLength(content: any) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (c?.type === "text") n += String(c.text ?? "").length;
    else if (c?.type === "tool_result") n += textLength(c.content);
  }
  return n;
}

/** @param m an Anthropic user message that carries tool results */
const isAnthropicResults = (m: any) =>
  m?.role === "user" &&
  Array.isArray(m.content) &&
  m.content.some((c: { type?: string } | null) => c?.type === "tool_result");

/** Splits an OpenAI-compatible or Anthropic request body into its parts. */
export function requestParts(body: string): Parts {
  const p: Parts = {
    total: body.length,
    tools: 0,
    system: 0,
    task: 0,
    calls: 0,
    results: 0,
    latest: 0,
  };
  let req;
  try {
    req = JSON.parse(body);
  } catch {
    return p;
  }
  p.tools = JSON.stringify(req.tools ?? []).length;
  if (typeof req.system === "string") p.system += req.system.length;
  const messages: any[] = Array.isArray(req.messages) ? req.messages : [];
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m?.role === "assistant") lastAssistant = i;
  });
  messages.forEach((m, i) => {
    const isResult = m?.role === "tool" || isAnthropicResults(m);
    if (isResult) {
      if (i > lastAssistant) p.latest += textLength(m.content);
      else p.results += textLength(m.content);
    } else if (m?.role === "system") p.system += textLength(m.content);
    else if (m?.role === "user") p.task += textLength(m.content);
    else if (m?.role === "assistant")
      p.calls += JSON.stringify(m.tool_calls ?? m.content ?? "").length;
  });
  return p;
}

/**
 * A `fetch` that times each model request and reports it with its parts. The time runs until
 * the reply has been read, since that is what the loop waits for.
 */
export function timedFetch(
  fetch: Fetch,
  onTurn: (turn: Turn) => void,
  clock: () => number = () => performance.now(),
): Fetch {
  return async (url, init) => {
    const parts = requestParts(String(init?.body ?? ""));
    const start = clock();
    const res = await fetch(url, init);
    const text = await res.text();
    onTurn({ ms: clock() - start, parts });
    return { ok: res.ok, status: res.status, text: async () => text };
  };
}

const HEADER = [
  "| List | Run | Steps | Model turns | Model time | Tool time | Input/turn (mean) | Input/turn (max) | Output/turn (mean) | Tools % | Instructions % | Calls % | Old results % | New results % |",
  "| ---- | --- | ----- | ----------- | ---------- | --------- | ----------------- | ---------------- | ------------------ | ------- | -------------- | ------- | ------------- | ------------- |",
];

/**
 * Per run: the model's time and the tools' time, the tokens a turn sent and received, and what
 * share of the characters sent over the run each part took (Instructions: the system text and
 * the user's messages). The rest of 100 % is the requests' JSON.
 */
export function formatBreakdown(
  runs: Array<{
    list: string;
    run: number;
    steps: number;
    turns: Turn[];
    calls: Array<{ ms?: number }>;
  }>,
) {
  const rows = runs.map((r) => {
    const n = r.turns.length || 1;
    const sum = (f: (t: Turn) => number) => r.turns.reduce((s, t) => s + f(t), 0);
    const total = sum((t) => t.parts.total) || 1;
    const pct = (x: number) => Math.round((100 * x) / total);
    const toolMs = r.calls.reduce((s, c) => s + (c.ms ?? 0), 0);
    return (
      `| ${r.list} | ${r.run} | ${r.steps} | ${r.turns.length} | ` +
      `${Math.round(sum((t) => t.ms) / 1000)} s | ${Math.round(toolMs / 1000)} s | ` +
      `${Math.round(sum((t) => t.input ?? 0) / n)} | ` +
      `${Math.max(0, ...r.turns.map((t) => t.input ?? 0))} | ` +
      `${Math.round(sum((t) => t.output ?? 0) / n)} | ` +
      `${pct(sum((t) => t.parts.tools))} | ` +
      `${pct(sum((t) => t.parts.system + t.parts.task))} | ` +
      `${pct(sum((t) => t.parts.calls))} | ${pct(sum((t) => t.parts.results))} | ` +
      `${pct(sum((t) => t.parts.latest))} |`
    );
  });
  return [...HEADER, ...rows].join("\n");
}
