/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Model provider adapters (docs/specs/builtin-agent.md B6, B11): Anthropic's Messages API and
// the OpenAI-compatible chat completions API that Ollama, LM Studio, the llama.cpp server and
// vLLM serve, written against the HTTP APIs directly so that no SDK is added. The caller passes
// `fetch`, so the same code runs in Firefox's parent process and in Node (the bench).

/**
 * @typedef {{ type: "text", text: string } | { type: "image", mimeType: string, data: string }} ToolContent
 *   A tool result's content, as MCP's CallToolResult carries it.
 * @typedef {{ id: string, name: string, args: Record<string, any> | null, error?: string }} ToolCall
 *   `error` says why the call cannot run (its arguments are not a JSON object); `args` is then
 *   null.
 * @typedef {{ id: string, name: string, isError: boolean, content: ToolContent[] }} ToolResult
 * @typedef {{ role: "user", text: string }
 *   | { role: "assistant", text: string, toolCalls: ToolCall[], raw?: { kind: string, content: any[] } }
 *   | { role: "tool", results: ToolResult[] }} ChatMessage
 *   A provider-neutral message. `raw` keeps an Anthropic reply's blocks (thinking included),
 *   which the API wants back unchanged.
 * @typedef {{ kind: "anthropic" | "openai", endpoint: string, model: string, vision?: boolean,
 *   priceIn?: number, priceOut?: number, maxOutput?: number }} Provider
 * @typedef {{ name: string, description: string, inputSchema: any }} ToolDef
 * @typedef {{ input: number, output: number, estimated: boolean }} Usage
 *   `estimated`: the server reported no usage, so both are characters divided by four (B10).
 * @typedef {{ message: Extract<ChatMessage, { role: "assistant" }>, usage: Usage, stop: string }} Reply
 * @typedef {{ key: string, system: string, tools: ToolDef[], messages: ChatMessage[] }} RequestInput
 * @typedef {(url: string, init: any) => Promise<{ ok: boolean, status: number, text(): Promise<string> }>} Fetch
 */

export const ANTHROPIC_VERSION = "2023-06-01";
/** Anthropic requires `max_tokens`; one agent turn is a short reply or a few tool calls. */
export const ANTHROPIC_MAX_OUTPUT = 8192;
/** Longest provider error shown (security.md: errors may echo the key). */
export const ERROR_CHARS = 200;

export class ProviderError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Why `endpoint` may not be used, or null (B11, Behaviour 9): `https://` unless on this
 * machine, and only on this machine with `local_only`.
 * @param {string} endpoint @param {{ localOnly: boolean }} opts
 * @returns {string | null}
 */
export function checkEndpoint(endpoint, { localOnly }) {
  /** @type {URL} */
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return "an endpoint must be an http:// or https:// address";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "an endpoint must be an http:// or https:// address";
  if (url.username || url.password) return "an endpoint must not carry a user name or password";
  // The request's path is added after the endpoint: a query or fragment would swallow it.
  if (url.search || url.hash) return "an endpoint must not carry a query or a fragment";
  const loopback = LOOPBACK.has(url.hostname);
  if (localOnly && !loopback) return `local_only refuses ${url.hostname}`;
  if (!loopback && url.protocol !== "https:")
    return "an endpoint that is not on this machine must be https://";
  return null;
}

/**
 * Whether `endpoint` is on this machine (a local server such as Ollama, LM Studio, llama.cpp
 * or vLLM), by its host alone.
 * @param {string} endpoint
 */
export function isLocalEndpoint(endpoint) {
  try {
    return LOOPBACK.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/** @param {string} endpoint */
const base = (endpoint) => endpoint.replace(/\/+$/, "");

/**
 * The HTTP request for one model turn. The key goes only into a header.
 * @param {Provider} provider @param {RequestInput} input
 * @returns {{ url: string, headers: Record<string, string>, body: string }}
 */
export function buildRequest(provider, input) {
  return provider.kind === "anthropic"
    ? anthropicRequest(provider, input)
    : openaiRequest(provider, input);
}

/** @param {Provider} provider @param {RequestInput} input */
function anthropicRequest(provider, { key, system, tools, messages }) {
  const root = base(provider.endpoint);
  const body = {
    model: provider.model,
    max_tokens: provider.maxOutput ?? ANTHROPIC_MAX_OUTPUT,
    system,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    })),
    messages: messages.flatMap(anthropicMessage),
    // The tools and system text repeat on every turn of a task; caching them makes the
    // following turns cheaper and faster.
    cache_control: { type: "ephemeral" },
  };
  return {
    url: `${root.endsWith("/v1") ? root : `${root}/v1`}/messages`,
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  };
}

/** @param {ChatMessage} m @returns {any[]} */
function anthropicMessage(m) {
  if (m.role === "user") return [{ role: "user", content: m.text }];
  if (m.role === "assistant") {
    if (m.raw?.kind === "anthropic") return [{ role: "assistant", content: m.raw.content }];
    const content = [
      ...(m.text ? [{ type: "text", text: m.text }] : []),
      ...m.toolCalls.map((c) => ({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: c.args ?? {},
      })),
    ];
    return content.length ? [{ role: "assistant", content }] : [];
  }
  return [
    {
      role: "user",
      content: m.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        is_error: r.isError,
        content: r.content.map((c) =>
          c.type === "text"
            ? { type: "text", text: c.text }
            : { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } },
        ),
      })),
    },
  ];
}

/** @param {Provider} provider @param {RequestInput} input */
function openaiRequest(provider, { key, system, tools, messages }) {
  /** @type {Record<string, any>} */
  const body = {
    model: provider.model,
    messages: [{ role: "system", content: system }, ...messages.flatMap(openaiMessage)],
    tools: tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    })),
  };
  if (provider.maxOutput) body.max_tokens = provider.maxOutput;
  /** @type {Record<string, string>} */
  const headers = { "content-type": "application/json" };
  // Local servers take no key; sending an empty bearer makes some of them refuse the request.
  if (key) headers.authorization = `Bearer ${key}`;
  return {
    url: `${base(provider.endpoint)}/chat/completions`,
    headers,
    body: JSON.stringify(body),
  };
}

/** @param {ChatMessage} m @returns {any[]} */
function openaiMessage(m) {
  if (m.role === "user") return [{ role: "user", content: m.text }];
  if (m.role === "assistant") {
    /** @type {Record<string, any>} */
    const out = { role: "assistant", content: m.text };
    if (m.toolCalls.length)
      out.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      }));
    return [out];
  }
  // A tool message holds text only; images follow, after every tool message of the turn, as a
  // user message, which vision models served this way read.
  const tools = m.results.map((r) => {
    const text = r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
    return { role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${text}` : text };
  });
  const images = m.results.flatMap((r) => {
    const parts = r.content.flatMap((c) =>
      c.type === "image"
        ? [{ type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } }]
        : [],
    );
    return parts.length
      ? [
          {
            role: "user",
            content: [{ type: "text", text: `The image from ${r.name} (${r.id}):` }, ...parts],
          },
        ]
      : [];
  });
  return [...tools, ...images];
}

/** @param {number} chars */
const estimate = (chars) => Math.ceil(chars / 4);

/**
 * One model turn read from a reply body.
 * @param {Provider} provider @param {any} json @param {string} requestBody  for an estimate
 * @returns {Reply}
 */
export function parseReply(provider, json, requestBody) {
  return provider.kind === "anthropic"
    ? anthropicReply(json, requestBody)
    : openaiReply(json, requestBody);
}

/** @param {any} json @param {string} requestBody @returns {Reply} */
function anthropicReply(json, requestBody) {
  if (!json || !Array.isArray(json.content))
    throw new ProviderError("the reply is not a Messages API reply");
  /** @type {any[]} */
  const content = json.content;
  const text = content
    .filter((b) => b?.type === "text")
    .map((b) => String(b.text))
    .join("\n");
  const toolCalls = content
    .filter((b) => b?.type === "tool_use")
    .map((b, i) => toolCall(b.id, i, b.name, b.input, false));
  const u = json.usage;
  const usage =
    typeof u?.input_tokens === "number"
      ? {
          input:
            u.input_tokens +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0),
          output: u.output_tokens ?? 0,
          estimated: false,
        }
      : {
          input: estimate(requestBody.length),
          output: estimate(JSON.stringify(content).length),
          estimated: true,
        };
  return {
    message: { role: "assistant", text, toolCalls, raw: { kind: "anthropic", content } },
    usage,
    stop: String(json.stop_reason ?? ""),
  };
}

/** @param {any} json @param {string} requestBody @returns {Reply} */
function openaiReply(json, requestBody) {
  const choice = json?.choices?.[0];
  const msg = choice?.message;
  if (!msg || typeof msg !== "object")
    throw new ProviderError("the reply is not a chat completions reply");
  /** @type {any[]} */
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls = calls.map((c, i) =>
    toolCall(c?.id, i, c?.function?.name, c?.function?.arguments, true),
  );
  const u = json.usage;
  const usage =
    typeof u?.prompt_tokens === "number"
      ? { input: u.prompt_tokens, output: u.completion_tokens ?? 0, estimated: false }
      : {
          input: estimate(requestBody.length),
          output: estimate(JSON.stringify(msg).length),
          estimated: true,
        };
  return {
    message: {
      role: "assistant",
      text: typeof msg.content === "string" ? msg.content : "",
      toolCalls,
    },
    usage,
    stop: String(choice.finish_reason ?? ""),
  };
}

/**
 * A tool call as the loop takes it. Arguments arrive as a JSON string (OpenAI's API), or as an
 * object (Anthropic's, and some local servers); a call without an id gets one, since the
 * result must name it.
 * @param {unknown} id @param {number} index @param {unknown} name @param {unknown} raw
 * @param {boolean} json  arguments may come as a JSON string (OpenAI-compatible)
 * @returns {ToolCall}
 */
function toolCall(id, index, name, raw, json) {
  const call = {
    id: typeof id === "string" && id ? id : `call_${index + 1}`,
    name: String(name ?? ""),
  };
  let args = raw;
  if (json && typeof raw === "string") {
    try {
      args = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return { ...call, args: null, error: "its arguments are not valid JSON" };
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args))
    return { ...call, args: null, error: "its arguments are not a JSON object" };
  return { ...call, args: /** @type {Record<string, any>} */ (args) };
}

/**
 * A provider's error as shown: the key replaced by `•••` before the text is cut, so no part of
 * it survives the cut, and at most ERROR_CHARS characters.
 * @param {number} status @param {string} body @param {string} key
 */
export function providerErrorText(status, body, key) {
  const clean = key ? body.split(key).join("•••") : body;
  const chars = [...`${status}: ${clean}`];
  return chars.length > ERROR_CHARS
    ? `${chars.slice(0, ERROR_CHARS - 1).join("")}…`
    : chars.join("");
}

/**
 * One model turn over HTTP: only to the configured endpoint, with no cookies and no
 * redirects (B11).
 * @param {Provider} provider
 * @param {RequestInput & { fetch: Fetch, signal?: AbortSignal, localOnly?: boolean }} input
 * @returns {Promise<Reply>}
 */
export async function callModel(provider, input) {
  const refused = checkEndpoint(provider.endpoint, { localOnly: input.localOnly ?? false });
  if (refused) throw new ProviderError(refused);
  const req = buildRequest(provider, input);
  const res = await input.fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    credentials: "omit",
    redirect: "error",
    signal: input.signal,
  });
  const text = await res.text();
  if (!res.ok) throw new ProviderError(providerErrorText(res.status, text, input.key), res.status);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError("the reply is not JSON", res.status);
  }
  return parseReply(provider, json, req.body);
}
