// docs/specs/builtin-agent.md Behaviour 2, B11, B12: setup asks only 127.0.0.1 on the local
// servers' ports, 1 s each, with no cookies and no redirects; and a local Ollama model gets a
// context the tool definitions fit in (docs/agent-bench.md, "Context length").
import { describe, expect, test } from "vitest";
import {
  LOCAL_SERVERS,
  MIN_CONTEXT,
  OLLAMA_DEFAULT_CONTEXT,
  ctxModelName,
  localModelState,
  modelChoices,
  ollamaContext,
  ollamaPlacement,
  pickerEntries,
  placementText,
  prepareLocalModel,
  probeLocal,
  providerKey,
  unavailableText,
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
    expect(JSON.parse(set.calls[0]?.init.body)).toEqual({ model: "m" });
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
    expect(JSON.parse(calls[1]?.init.body)).toEqual({
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

// docs/specs/agent-speed.md Behaviour 7, S8: setup says where a local model runs, since Ollama
// leaves out an integrated GPU unless told to and a model on the CPU is several times slower.
describe("where a local Ollama model runs", () => {
  const GENERATE = "http://127.0.0.1:11434/api/generate";
  const PS = "http://127.0.0.1:11434/api/ps";
  const ps = (/** @type {any[]} */ models) => ({ models });

  test("loads the model with no prompt, then reads its GPU share and context from ps", async () => {
    const { fetch, calls } = fake({
      [GENERATE]: { model: "qwen3:14b-ctx32768", response: "", done: true },
      [PS]: ps([
        { name: "other:7b", size: 100, size_vram: 0 },
        { name: "qwen3:14b-ctx32768", size: 1000, size_vram: 1000, context_length: 32768 },
      ]),
    });
    expect(await ollamaPlacement(fetch, "http://127.0.0.1:11434/v1", "qwen3:14b-ctx32768")).toEqual(
      { gpu: 1, context: 32768 },
    );
    expect(calls.map((c) => c.url)).toEqual([GENERATE, PS]);
    expect(JSON.parse(calls[0]?.init.body)).toEqual({ model: "qwen3:14b-ctx32768", stream: false });
    for (const { init } of calls) {
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("error");
    }
  });

  test("a split model, and a model ps names with Ollama's :latest tag", async () => {
    const { fetch } = fake({
      [GENERATE]: { done: true },
      [PS]: ps([{ name: "llama3:latest", size: 1000, size_vram: 520 }]),
    });
    expect(await ollamaPlacement(fetch, "http://127.0.0.1:11434/v1", "llama3")).toEqual({
      gpu: 0.52,
      context: null,
    });
  });

  test("says nothing when the server cannot tell", async () => {
    const down = fake({});
    expect(await ollamaPlacement(down.fetch, "http://127.0.0.1:11434/v1", "m")).toBeNull();
    const absent = fake({ [GENERATE]: { done: true }, [PS]: ps([{ name: "x", size: 1 }]) });
    expect(await ollamaPlacement(absent.fetch, "http://127.0.0.1:11434/v1", "m")).toBeNull();
    const odd = fake({ [GENERATE]: { done: true }, [PS]: ps([{ name: "m", size: 0 }]) });
    expect(await ollamaPlacement(odd.fetch, "http://127.0.0.1:11434/v1", "m")).toBeNull();
  });

  test("asks only Ollama on this machine", async () => {
    const { fetch, calls } = fake({});
    expect(await ollamaPlacement(fetch, "https://llm.example/v1", "m")).toBeNull();
    expect(await ollamaPlacement(fetch, "http://127.0.0.1:8080/v1", "m")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("the line setup shows", () => {
    expect(placementText("q", { gpu: 1, context: 32768 })).toBe(
      "q runs on the GPU, with 32,768 tokens of context",
    );
    expect(placementText("q", { gpu: 0.52, context: null })).toBe(
      "q runs 48% on the CPU and 52% on the GPU",
    );
    expect(placementText("q", { gpu: 0, context: 65536 })).toBe(
      "q runs on the CPU, with 65,536 tokens of context: an integrated GPU needs " +
        "OLLAMA_IGPU_ENABLE=1 in Ollama's environment (guide: The GPU)",
    );
  });
});

// Behaviour 7: the picker shows which models are there now, and a conversation whose model is
// gone asks for another before a task starts rather than failing in its middle.
describe("whether a local model is still there", () => {
  const MODELS = "http://127.0.0.1:11434/v1/models";
  const local = (/** @type {string} */ model) => ({
    name: "local",
    kind: /** @type {const} */ ("openai"),
    endpoint: "http://127.0.0.1:11434/v1",
    model,
    vision: false,
  });

  test("its server lists it, or no longer does", async () => {
    const { fetch, calls } = fake({ [MODELS]: { data: [{ id: "qwen3:14b" }] } });
    expect(await localModelState(fetch, local("qwen3:14b"))).toBe("available");
    expect(await localModelState(fetch, local("llama3:8b"))).toBe("gone");
    expect(calls[0]?.url).toBe(MODELS);
    expect(calls[0]?.init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
  });

  test("nothing answers on its port", async () => {
    const { fetch } = fake({});
    expect(await localModelState(fetch, local("qwen3:14b"))).toBe("down");
  });

  test("a server without a model list, or a slow one, is not judged", async () => {
    expect(await localModelState(fake({ [MODELS]: 404 }).fetch, local("m"))).toBe("unknown");
    const slow = fake({ [MODELS]: "hang" });
    expect(await localModelState(slow.fetch, local("m"), { timeoutMs: 50 })).toBe("unknown");
  });

  test("the window's words for a model that is not there", () => {
    expect(unavailableText(local("qwen3:14b"), "gone")).toBe(
      "qwen3:14b is no longer available: 127.0.0.1:11434 does not list it",
    );
    expect(unavailableText(local("qwen3:14b"), "down")).toBe(
      "qwen3:14b is not available: nothing answers at 127.0.0.1:11434",
    );
    expect(unavailableText(local("qwen3:14b"), "available")).toBeNull();
    expect(unavailableText(local("qwen3:14b"), "unknown")).toBeNull();
  });

  // docs/specs/builtin-agent-cli.md C4: an agent CLI whose program is not set up, gone or refused.
  test("an agent CLI whose program is gone is not available, and says how to find it again", () => {
    const claude = {
      name: "claude",
      kind: /** @type {const} */ ("cli"),
      cli: "claude-code",
      endpoint: "",
      model: "sonnet",
      vision: false,
    };
    expect(unavailableText(claude, "gone")).toBe(
      "claude-code is not available: its program is not set up, gone or refused; " +
        "add: agent CLI in this list finds it again",
    );
    expect(unavailableText(claude, "available")).toBeNull();
    expect(unavailableText(claude, null)).toBeNull();
    // Each CLI is its own entry, whatever the model.
    expect(providerKey(claude)).not.toBe(providerKey({ ...claude, cli: "codex" }));
  });

  test("the probe also asks the configured local endpoints, once each, never a remote one", async () => {
    const { fetch, calls } = fake({
      "http://127.0.0.1:8000/v1/models": { data: [{ id: "a" }] },
      "http://127.0.0.1:11434/v1/models": { data: [{ id: "b" }] },
    });
    const found = await probeLocal(fetch, {
      extra: [
        { server: "vllm", endpoint: "http://127.0.0.1:8000/v1/" },
        { server: "local", endpoint: "http://127.0.0.1:11434/v1" },
        { server: "far", endpoint: "https://llm.example/v1" },
        { server: "user", endpoint: "http://u:p@127.0.0.1:9000/v1" },
        { server: "lookalike", endpoint: "http://127.0.0.1.evil.example:9000/v1" },
      ],
    });
    expect(found).toEqual([
      { server: "ollama", endpoint: "http://127.0.0.1:11434/v1", models: ["b"] },
      { server: "vllm", endpoint: "http://127.0.0.1:8000/v1", models: ["a"] },
    ]);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "http://127.0.0.1:11434/v1/models",
      "http://127.0.0.1:1234/v1/models",
      "http://127.0.0.1:8000/v1/models",
      "http://127.0.0.1:8080/v1/models",
    ]);
  });

  test("a provider off this machine, or Anthropic's API, gets no request", async () => {
    const { fetch, calls } = fake({});
    const hosted = { ...local("m"), endpoint: "https://llm.example/v1" };
    expect(await localModelState(fetch, hosted)).toBe("unknown");
    const anthropic = { ...local("m"), kind: /** @type {const} */ ("anthropic") };
    expect(await localModelState(fetch, anthropic)).toBe("unknown");
    expect(calls).toHaveLength(0);
  });
});

describe("the picker's entries", () => {
  const OLLAMA = "http://127.0.0.1:11434/v1";
  const provider = (
    /** @type {string} */ name,
    /** @type {string} */ endpoint,
    /** @type {string} */ model,
  ) => ({ name, kind: /** @type {const} */ ("openai"), endpoint, model, vision: false });
  const local = provider("local", OLLAMA, "qwen3:14b");
  const hosted = provider("hosted", "https://llm.example/v1", "big");
  const found = [{ server: "ollama", endpoint: OLLAMA, models: ["qwen3:14b", "llama3:8b"] }];

  test("configured providers first, then what the servers list that none names", () => {
    const states = new Map([[providerKey(local), /** @type {const} */ ("available")]]);
    const entries = pickerEntries({ providers: [local, hosted], found, states, current: null });
    expect(entries).toEqual([
      { provider: local, state: "available", current: false },
      { provider: hosted, state: null, current: false },
      {
        local: { server: "ollama", endpoint: OLLAMA, model: "llama3:8b" },
        state: "available",
        current: false,
      },
    ]);
  });

  test("before the probe answers, a local provider's state is not known", () => {
    const entries = pickerEntries({ providers: [local], found: null, states: null, current: null });
    expect(entries).toEqual([{ provider: local, state: null, current: false }]);
  });

  test("a configured model its server no longer lists is shown as gone", () => {
    const states = new Map([[providerKey(local), /** @type {const} */ ("gone")]]);
    const entries = pickerEntries({ providers: [local], found: [], states, current: null });
    expect(entries).toEqual([{ provider: local, state: "gone", current: false }]);
  });

  test("the conversation's model is marked, and listed even when no longer there", () => {
    const picked = provider("ollama", OLLAMA, "llama3:8b");
    expect(
      pickerEntries({ providers: [], found, states: new Map(), current: picked }).map(
        (e) => e.current,
      ),
    ).toEqual([false, true]);
    const gone = provider("ollama", OLLAMA, "mistral:7b");
    const states = new Map([[providerKey(gone), /** @type {const} */ ("gone")]]);
    expect(pickerEntries({ providers: [], found, states, current: gone })[0]).toEqual({
      provider: gone,
      state: "gone",
      current: true,
    });
  });

  test("a configured provider in use is marked, not listed twice", () => {
    const entries = pickerEntries({ providers: [local], found, states: null, current: local });
    expect(entries.filter((e) => e.current)).toEqual([
      { provider: local, state: null, current: true },
    ]);
    expect(entries).toHaveLength(2);
  });

  // docs/specs/builtin-agent-cli.md Behaviour 17: a CLI's models are chosen in the picker, from
  // Vimma's own list of the models the CLI takes; nothing is asked of the CLI to list them.
  describe("an agent CLI's models", () => {
    const claude = {
      name: "claude",
      kind: /** @type {const} */ ("cli"),
      cli: "claude-code",
      endpoint: "",
      model: "sonnet",
      vision: false,
    };
    const as = (/** @type {string} */ model) => ({ ...claude, model });

    test("each model the CLI takes is a row after the configured one, then another model", () => {
      const states = new Map([[providerKey(claude), /** @type {const} */ ("available")]]);
      const entries = pickerEntries({ providers: [claude], found: [], states, current: null });
      expect(entries).toEqual([
        { provider: claude, state: "available", current: false },
        { provider: as("opus"), state: "available", current: false, cliModel: true },
        { provider: as("haiku"), state: "available", current: false, cliModel: true },
        { provider: as(""), state: "available", current: false, cliModel: true },
        { provider: claude, state: "available", current: false, otherModel: true },
      ]);
    });

    test("the conversation's model is marked in use on its row, and listed once", () => {
      const entries = pickerEntries({
        providers: [claude],
        found: null,
        states: null,
        current: as("opus"),
      });
      expect(entries.filter((e) => e.current)).toEqual([
        { provider: as("opus"), state: null, current: true, cliModel: true },
      ]);
      expect(entries).toHaveLength(5);
    });

    test("a model another provider of the CLI names is that provider's row only", () => {
      const opus = { ...as("opus"), name: "claude-2" };
      const entries = pickerEntries({
        providers: [claude, opus],
        found: null,
        states: null,
        current: null,
      });
      expect(entries.map((e) => [e.provider?.name, e.provider?.model, !!e.otherModel])).toEqual([
        ["claude", "sonnet", false],
        ["claude-2", "opus", false],
        ["claude", "haiku", false],
        ["claude", "", false],
        ["claude", "sonnet", true],
      ]);
    });

    test("another CLI's rows come from its CLIS entry alone", () => {
      /** @type {any} */
      const clis = {
        "made-up": {
          id: "made-up",
          bin: "mu",
          title: "Made Up",
          model: "small",
          models: ["small", "large", ""],
        },
      };
      const mu = { ...claude, name: "mu", cli: "made-up", model: "small" };
      const entries = pickerEntries({
        providers: [mu],
        found: null,
        states: null,
        current: null,
        clis,
      });
      expect(entries.map((e) => [e.provider?.model, !!e.cliModel, !!e.otherModel])).toEqual([
        ["small", false, false],
        ["large", true, false],
        ["", true, false],
        ["small", false, true],
      ]);
    });

    test("a model typed earlier, in use and in no list, is listed as the conversation's", () => {
      const typed = as("claude-opus-4-1");
      const entries = pickerEntries({
        providers: [claude],
        found: null,
        states: null,
        current: typed,
      });
      expect(entries[0]).toEqual({ provider: typed, state: null, current: true });
    });
  });
});
