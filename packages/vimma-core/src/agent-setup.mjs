/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's setup for a local model (docs/specs/builtin-agent.md Behaviour 2, B11,
// B12): the probe of the usual local servers' ports, only on 127.0.0.1 and only while setup is
// open, and the context length of an Ollama model. Ollama's OpenAI-compatible API takes no
// context length and its default of 4096 tokens holds less than the tool definitions
// (docs/agent-bench.md, "Context length"), so setup makes a copy of the model with `num_ctx`
// set, the way Ollama's documentation says to: a new name that shares the original's weights.
// The caller passes `fetch`, as for the providers.

import { checkEndpoint } from "./agent-providers.mjs";

/** @typedef {import("./agent-providers.mjs").Fetch} Fetch */
/** @typedef {{ server: string, endpoint: string, models: string[] }} LocalServer */
/**
 * @typedef {(ms: number) => AbortSignal} Timeout  a signal that aborts after `ms`; the browser's
 *   parent process passes its own, since its module global has no AbortSignal.timeout
 */

/** @type {Timeout} */
const defaultTimeout = (ms) => AbortSignal.timeout(ms);

/** The servers setup asks, on 127.0.0.1 only (Behaviour 2). */
const OLLAMA_PORT = 11434;
export const LOCAL_SERVERS = Object.freeze([
  Object.freeze({ server: "ollama", port: OLLAMA_PORT }),
  Object.freeze({ server: "lm studio", port: 1234 }),
  Object.freeze({ server: "llama.cpp", port: 8080 }),
]);
export const PROBE_TIMEOUT_MS = 1000;
/** Ollama's context length for a model that sets none. */
export const OLLAMA_DEFAULT_CONTEXT = 4096;
/** What a ten-item list needs on the bench's shortest path, rounded up to a power of two. */
export const MIN_CONTEXT = 32768;
const MAX_MODEL = 200;

/** @param {string} url @param {AbortSignal} signal @param {Fetch} fetch @param {any} [body] */
async function request(fetch, url, signal, body) {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    credentials: "omit",
    redirect: "error",
    signal,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return JSON.parse(await res.text());
}

/** A model name worth listing: plain text a picker can show. @param {unknown} id */
const isModelName = (id) =>
  typeof id === "string" &&
  id.length > 0 &&
  id.length <= MAX_MODEL &&
  ![...id].some((c) => /** @type {number} */ (c.codePointAt(0)) < 0x20 || c === "\x7f");

/**
 * The local servers that answer `GET /v1/models` within the timeout, with their models.
 * @param {Fetch} fetch
 * @param {{ servers?: readonly { server: string, port: number }[], timeoutMs?: number,
 *   timeout?: Timeout }} [opts]  `servers`: in place of LOCAL_SERVERS (a test's own server)
 * @returns {Promise<LocalServer[]>}
 */
export async function probeLocal(
  fetch,
  { servers = LOCAL_SERVERS, timeoutMs = PROBE_TIMEOUT_MS, timeout = defaultTimeout } = {},
) {
  const found = await Promise.all(
    servers.map(async ({ server, port }) => {
      const endpoint = `http://127.0.0.1:${port}/v1`;
      try {
        const json = await request(fetch, `${endpoint}/models`, timeout(timeoutMs));
        const data = Array.isArray(json?.data) ? json.data : [];
        const models = data.map((/** @type {any} */ m) => m?.id).filter(isModelName);
        return [{ server, endpoint, models }];
      } catch {
        return [];
      }
    }),
  );
  return found.flat();
}

/**
 * The picker's lines, the first model first: it is preselected (B12).
 * @param {LocalServer[]} found
 */
export function modelChoices(found) {
  return found.flatMap(({ server, endpoint, models }) =>
    models.map((model) => ({ label: `${server} · ${model}`, server, endpoint, model })),
  );
}

/** `qwen2.5:7b` with 32768 → `qwen2.5:7b-ctx32768` (the bench's names too). */
export function ctxModelName(/** @type {string} */ model, /** @type {number} */ numCtx) {
  return `${model.includes(":") ? model : `${model}:latest`}-ctx${numCtx}`;
}

/** @param {string} endpoint an OpenAI-compatible base such as http://127.0.0.1:11434/v1 */
const ollamaRoot = (endpoint) => endpoint.replace(/\/v1\/?$/, "");

/**
 * The context length an Ollama model runs with: its `num_ctx`, or Ollama's default.
 * @param {Fetch} fetch @param {string} endpoint @param {string} model
 * @param {{ timeout?: Timeout }} [opts]
 */
export async function ollamaContext(fetch, endpoint, model, { timeout = defaultTimeout } = {}) {
  const signal = timeout(10 * PROBE_TIMEOUT_MS);
  const show = await request(fetch, `${ollamaRoot(endpoint)}/api/show`, signal, { model });
  const set = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(show?.parameters ?? ""))?.[1];
  return set ? Number(set) : OLLAMA_DEFAULT_CONTEXT;
}

/**
 * The model to use for a local server's `model`: an Ollama model with less than MIN_CONTEXT
 * gets its copy with `num_ctx` set. Another server's context is set where it starts (LM
 * Studio's load settings, llama.cpp's `-c`), which Vimma cannot change: `context` is null.
 * @param {Fetch} fetch @param {string} endpoint @param {string} model
 * @param {{ timeout?: Timeout }} [opts]
 * @returns {Promise<{ model: string, context: number | null, made: boolean }>}
 */
export async function prepareLocalModel(fetch, endpoint, model, { timeout = defaultTimeout } = {}) {
  const refused = checkEndpoint(endpoint, { localOnly: true });
  if (refused) throw new Error(refused);
  if (new URL(endpoint).port !== String(OLLAMA_PORT)) {
    return { model, context: null, made: false };
  }
  const context = await ollamaContext(fetch, endpoint, model, { timeout });
  if (context >= MIN_CONTEXT) return { model, context, made: false };
  const name = ctxModelName(model, MIN_CONTEXT);
  const signal = timeout(60 * PROBE_TIMEOUT_MS);
  const out = await request(fetch, `${ollamaRoot(endpoint)}/api/create`, signal, {
    model: name,
    from: model,
    parameters: { num_ctx: MIN_CONTEXT },
    stream: false,
  });
  if (out?.status !== "success") throw new Error(`Ollama could not make ${name}`);
  return { model: name, context: MIN_CONTEXT, made: true };
}
