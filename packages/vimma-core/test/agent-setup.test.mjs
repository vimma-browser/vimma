// docs/specs/builtin-agent.md Behaviour 2, B11, B12: setup asks only 127.0.0.1 on the local
// servers' ports, 1 s each, with no cookies and no redirects; and a local Ollama model gets a
// context the tool definitions fit in (docs/agent-bench.md, "Context length").
import { describe, expect, test } from "vitest";
import {
  LOCAL_SERVERS,
  MIN_CONTEXT,
  OLLAMA_DEFAULT_CONTEXT,
  ctxModelName,
  modelChoices,
  ollamaContext,
  prepareLocalModel,
  probeLocal,
} from "../src/agent-setup.mjs";

/**
 * A fake fetch: `routes` maps a URL to a reply body (an object, sent as JSON) or a status.
 * @param {Record<string, any>} routes
 */
function fake(routes) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  /** @type {any} */
  const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    if (!(url in routes)) throw new TypeError("NetworkError when attempting to fetch resource.");
    const r = routes[url];
    if (typeof r === "number") return { ok: false, status: r, text: async () => "" };
    if (r === "hang") {
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(r) };
  };
  return { fetch, calls };
}

describe("the probe", () => {
  test("only 127.0.0.1 on Ollama's, LM Studio's and llama.cpp's ports", () => {
    expect(LOCAL_SERVERS).toEqual([
      { server: "ollama", port: 11434 },
      { server: "lm studio", port: 1234 },
      { server: "llama.cpp", port: 8080 },
    ]);
  });

  test("lists the models of the servers that answer, with no cookies and no redirects", async () => {
    const { fetch, calls } = fake({
      "http://127.0.0.1:11434/v1/models": { data: [{ id: "qwen3:14b" }, { id: "llama3:8b" }] },
      "http://127.0.0.1:1234/v1/models": 404,
    });
    const found = await probeLocal(fetch);
    expect(found).toEqual([
      {
        server: "ollama",
        endpoint: "http://127.0.0.1:11434/v1",
        models: ["qwen3:14b", "llama3:8b"],
      },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:11434/v1/models",
      "http://127.0.0.1:1234/v1/models",
      "http://127.0.0.1:8080/v1/models",
    ]);
    for (const { init } of calls) {
      expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("a server that does not answer in time is left out", async () => {
    const { fetch } = fake({ "http://127.0.0.1:8080/v1/models": "hang" });
    const started = Date.now();
    expect(await probeLocal(fetch, { timeoutMs: 50 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("model names that are not plain text are dropped", async () => {
    const { fetch } = fake({
      "http://127.0.0.1:11434/v1/models": {
        data: [{ id: "ok:1b" }, { id: 5 }, { id: "a\nb" }, { id: "x".repeat(201) }, null],
      },
    });
    expect((await probeLocal(fetch))[0]?.models).toEqual(["ok:1b"]);
  });

  test("the choices read as `ollama · qwen3:14b`, the first one first", () => {
    expect(
      modelChoices([
        { server: "ollama", endpoint: "http://127.0.0.1:11434/v1", models: ["a", "b"] },
        { server: "llama.cpp", endpoint: "http://127.0.0.1:8080/v1", models: ["c"] },
      ]).map((c) => c.label),
    ).toEqual(["ollama · a", "ollama · b", "llama.cpp · c"]);
  });
});

describe("the context length of a local Ollama model", () => {
  const SHOW = "http://127.0.0.1:11434/api/show";

  test("reads num_ctx, or Ollama's default when the model sets none", async () => {
    expect(OLLAMA_DEFAULT_CONTEXT).toBe(4096);
    const set = fake({ [SHOW]: { parameters: "stop <|im_end|>\nnum_ctx 65536\n" } });
    expect(await ollamaContext(set.fetch, "http://127.0.0.1:11434/v1", "m")).toBe(65536);
    expect(JSON.parse(set.calls[0].init.body)).toEqual({ model: "m" });
    const unset = fake({ [SHOW]: { parameters: "stop x" } });
    expect(await ollamaContext(unset.fetch, "http://127.0.0.1:11434/v1", "m")).toBe(4096);
  });

  test("a model with enough context is used as it is", async () => {
    const { fetch, calls } = fake({ [SHOW]: { parameters: "num_ctx 32768" } });
    expect(await prepareLocalModel(fetch, "http://127.0.0.1:11434/v1", "qwen3:14b")).toEqual({
      model: "qwen3:14b",
      context: 32768,
      made: false,
    });
    expect(calls).toHaveLength(1);
  });

  test("a model with less gets a copy with num_ctx set, sharing its weights", async () => {
    expect(MIN_CONTEXT).toBe(32768);
    const { fetch, calls } = fake({
      [SHOW]: { parameters: "" },
      "http://127.0.0.1:11434/api/create": { status: "success" },
    });
    expect(await prepareLocalModel(fetch, "http://127.0.0.1:11434/v1", "qwen3:14b")).toEqual({
      model: "qwen3:14b-ctx32768",
      context: 32768,
      made: true,
    });
    expect(JSON.parse(calls[1].init.body)).toEqual({
      model: "qwen3:14b-ctx32768",
      from: "qwen3:14b",
      parameters: { num_ctx: 32768 },
      stream: false,
    });
    expect(ctxModelName("llama3", 8192)).toBe("llama3:latest-ctx8192");
  });

  test("only on this machine", async () => {
    const { fetch, calls } = fake({});
    await expect(prepareLocalModel(fetch, "https://llm.example/v1", "m")).rejects.toThrow(
      "local_only refuses llm.example",
    );
    expect(calls).toHaveLength(0);
  });

  test("a server that is not Ollama is left as it is", async () => {
    const { fetch } = fake({});
    expect(await prepareLocalModel(fetch, "http://127.0.0.1:8080/v1", "m")).toEqual({
      model: "m",
      context: null,
      made: false,
    });
  });
});
