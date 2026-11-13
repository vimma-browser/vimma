/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What the bench needs from an Ollama server beyond the OpenAI-compatible API: its version and
// the model's size and quantisation for the results, and a context length. Ollama's /v1 API
// takes no context length and its default (4096 tokens) holds less than the tool definitions,
// so the bench makes a model that sets it, the way Ollama's documentation says to: a new name
// with `num_ctx` set, sharing the original's weights (nothing is downloaded).

import { httpFetch } from "./http-fetch.ts";

/** @param endpoint an OpenAI-compatible base such as http://127.0.0.1:11434/v1 */
export const ollamaRoot = (endpoint: string) => endpoint.replace(/\/v1\/?$/, "");

async function call(root: string, path: string, body?: any) {
  const res = await httpFetch(`${root}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ollama ${path}: ${res.status} ${text.slice(0, 200)}`);
  return text;
}

/** The name of the model with `numCtx` set: `qwen2.5:7b` → `qwen2.5:7b-ctx32768`. */
export function ctxModelName(model: string, numCtx: number) {
  return `${model.includes(":") ? model : `${model}:latest`}-ctx${numCtx}`;
}

/** Makes (or keeps) the model with the context length set; its name. */
export async function withContext(endpoint: string, model: string, numCtx: number) {
  const name = ctxModelName(model, numCtx);
  const out = await call(ollamaRoot(endpoint), "/api/create", {
    model: name,
    from: model,
    parameters: { num_ctx: numCtx },
    stream: false,
  });
  if (!/success/.test(out))
    throw new Error(`Ollama could not create ${name}: ${out.slice(0, 200)}`);
  return name;
}

/** The server's version and the model's details, for the results. */
export async function describe(endpoint: string, model: string) {
  const root = ollamaRoot(endpoint);
  const version = JSON.parse(await call(root, "/api/version")).version;
  const show = JSON.parse(await call(root, "/api/show", { model }));
  const numCtx = /(?:^|\n)num_ctx\s+(\d+)/.exec(show.parameters ?? "")?.[1];
  const trained = Object.entries(show.model_info ?? {}).find(([k]) =>
    k.endsWith(".context_length"),
  )?.[1];
  return {
    server: `Ollama ${version}`,
    parameters: show.details?.parameter_size ?? null,
    quantisation: show.details?.quantization_level ?? null,
    family: show.details?.family ?? null,
    numCtx: numCtx ? Number(numCtx) : null,
    trainedCtx: typeof trained === "number" ? trained : null,
  };
}

/** Where the model ran: Ollama's loaded models with how much of each is in GPU memory. */
export async function loaded(endpoint: string) {
  const ps = JSON.parse(await call(ollamaRoot(endpoint), "/api/ps"));
  return (ps.models ?? []).map((m: any) => ({
    name: m.name,
    size: m.size,
    sizeVram: m.size_vram,
    contextLength: m.context_length ?? null,
  }));
}
