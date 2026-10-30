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

import { CLIS } from "./agent-cli.mjs";
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
 * @param {{ servers?: readonly { server: string, port: number }[],
 *   extra?: readonly { server: string, endpoint: string }[], timeoutMs?: number,
 *   timeout?: Timeout }} [opts]  `servers`: in place of LOCAL_SERVERS (a test's own server);
 *   `extra`: the configured providers' local endpoints, so that a server on another port
 *   (vLLM's 8000) lists its models too; one off this machine is never asked
 * @returns {Promise<LocalServer[]>}
 */
export async function probeLocal(
  fetch,
  {
    servers = LOCAL_SERVERS,
    extra = [],
    timeoutMs = PROBE_TIMEOUT_MS,
    timeout = defaultTimeout,
  } = {},
) {
  /** @type {Map<string, string>} endpoint → server, the usual ports' names first */
  const asked = new Map();
  for (const { server, port } of servers) asked.set(`http://127.0.0.1:${port}/v1`, server);
  for (const { server, endpoint } of extra) {
    const base = endpoint.replace(/\/+$/, "");
    if (!checkEndpoint(base, { localOnly: true }) && !asked.has(base)) asked.set(base, server);
  }
  const found = await Promise.all(
    [...asked].map(async ([endpoint, server]) => {
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

/**
 * @typedef {"available" | "gone" | "down" | "unknown"} ModelState  whether a local server still
 *   has a model: it lists it, it lists others, nothing answers on its port, or it could not say
 *   (no model list, no answer in time, a provider off this machine that is never asked)
 * @typedef {import("./config.mjs").AgentProviderConfig} AgentProviderConfig
 */

/** The same kind, endpoint and model: one model, whatever its provider is named. */
export const providerKey = (/** @type {AgentProviderConfig} */ p) =>
  `${p.kind}\n${p.endpoint.replace(/\/+$/, "")}\n${p.model}${p.kind === "cli" ? `\n${p.cli}` : ""}`;

/**
 * Whether `provider`'s local server still lists its model (Behaviour 7): one `GET /v1/models` to
 * the provider's own endpoint, only on this machine and only for an OpenAI-compatible server.
 * Only "nothing answers" and "lists others" count against it, so a server without the route
 * or one busy loading a model is never refused a task it could run.
 * @param {Fetch} fetch @param {AgentProviderConfig} provider
 * @param {{ timeoutMs?: number, timeout?: Timeout }} [opts]
 * @returns {Promise<ModelState>}
 */
export async function localModelState(
  fetch,
  provider,
  { timeoutMs = PROBE_TIMEOUT_MS, timeout = defaultTimeout } = {},
) {
  if (provider.kind !== "openai" || checkEndpoint(provider.endpoint, { localOnly: true })) {
    return "unknown";
  }
  const url = `${provider.endpoint.replace(/\/+$/, "")}/models`;
  let res;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {},
      credentials: "omit",
      redirect: "error",
      signal: timeout(timeoutMs),
    });
  } catch (e) {
    return /** @type {any} */ (e)?.name === "AbortError" ? "unknown" : "down";
  }
  if (!res.ok) return "unknown";
  try {
    const data = JSON.parse(await res.text())?.data;
    if (!Array.isArray(data)) return "unknown";
    return data.some((/** @type {any} */ m) => m?.id === provider.model) ? "available" : "gone";
  } catch {
    return "unknown";
  }
}

/**
 * What the window says of a model whose server does not list it, or null when it may be used.
 * @param {AgentProviderConfig} provider @param {ModelState | null} state
 */
export function unavailableText(provider, state) {
  if (provider.kind === "cli") {
    // Its program's path pref is unset, or the file is gone or fails C4's checks.
    return state === "gone"
      ? `${provider.cli} is not available: its program is not set up, gone or refused; ` +
          "add: agent CLI in this list finds it again"
      : null;
  }
  const host = URL.canParse(provider.endpoint) ? new URL(provider.endpoint).host : "";
  if (state === "gone") return `${provider.model} is no longer available: ${host} does not list it`;
  if (state === "down") return `${provider.model} is not available: nothing answers at ${host}`;
  return null;
}

/**
 * @typedef {{ provider?: AgentProviderConfig,
 *   local?: { server: string, endpoint: string, model: string },
 *   state: ModelState | null, current: boolean, cliModel?: true, otherModel?: true }} PickerEntry
 *   `state` null: not known yet, or never asked (a hosted provider); `cliModel`: another model
 *   of a configured agent CLI, from its list (builtin-agent-cli Behaviour 17); `otherModel`: the
 *   row that asks for a model of that CLI by name
 */

/**
 * The model picker's entries (Behaviour 7): the conversation's own model first when nothing
 * else lists it (so a model that is gone is seen as gone), then the configured providers, then
 * each configured agent CLI's other models and a row to name one (builtin-agent-cli
 * Behaviour 7), under its first provider's name, then the models the local servers list that no
 * provider names.
 * @param {{ providers: AgentProviderConfig[], found: LocalServer[] | null,
 *   states: Map<string, ModelState> | null, current: AgentProviderConfig | null }} o
 *   `found`: the probe's servers, null until it answers; `states`: by providerKey
 * @returns {PickerEntry[]}
 */
export function pickerEntries({ providers, found, states, current }) {
  const currentKey = current ? providerKey(current) : null;
  const known = new Set(providers.map(providerKey));
  /** @type {PickerEntry[]} */
  const locals = (found ?? []).flatMap(({ server, endpoint, models }) =>
    models
      .map((model) => ({ server, endpoint, model }))
      .filter((l) => !known.has(providerKey({ name: "", kind: "openai", vision: false, ...l })))
      .map((local) => ({
        local,
        state: /** @type {ModelState} */ ("available"),
        current: providerKey({ name: "", kind: "openai", vision: false, ...local }) === currentKey,
      })),
  );
  /** @type {PickerEntry[]} */
  const configured = providers.map((p) => ({
    provider: p,
    state: states?.get(providerKey(p)) ?? null,
    current: providerKey(p) === currentKey,
  }));
  /** @type {Map<string, AgentProviderConfig>} each CLI's first provider */
  const bases = new Map();
  for (const p of providers) {
    if (p.kind === "cli" && p.cli && Object.hasOwn(CLIS, p.cli) && !bases.has(p.cli)) {
      bases.set(p.cli, p);
    }
  }
  /** @type {PickerEntry[]} */
  const cliModels = [...bases].flatMap(([cli, base]) => {
    const state = states?.get(providerKey(base)) ?? null;
    const named = new Set(
      providers.filter((p) => p.kind === "cli" && p.cli === cli).map((p) => p.model),
    );
    const info = /** @type {import("./agent-cli.mjs").CliInfo} */ (CLIS[cli]);
    return [
      ...info.models
        .filter((model) => !named.has(model))
        .map((model) => {
          const provider = { ...base, model };
          return {
            provider,
            state,
            current: providerKey(provider) === currentKey,
            cliModel: /** @type {const} */ (true),
          };
        }),
      { provider: base, state, current: false, otherModel: /** @type {const} */ (true) },
    ];
  });
  const listed = [...configured, ...cliModels, ...locals].some((e) => e.current);
  /** @type {PickerEntry[]} */
  const own =
    current && !listed
      ? [{ provider: current, state: states?.get(providerKey(current)) ?? null, current: true }]
      : [];
  return [...own, ...configured, ...cliModels, ...locals];
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
