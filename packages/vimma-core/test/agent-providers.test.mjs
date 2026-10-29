// docs/specs/builtin-agent.md B6, B10, B11: the Anthropic Messages and OpenAI-compatible
// adapters, written against the HTTP APIs with no SDK. The reply fixtures in
// fixtures/agent-providers/ are Ollama 0.40.12 (qwen2.5:1.5b) replies recorded from its
// OpenAI-compatible endpoint, and Anthropic replies in the documented Messages shape.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ProviderError,
  buildRequest,
  callModel,
  checkEndpoint,
  parseReply,
  providerErrorText,
} from "../src/agent-providers.mjs";

/** @param {string} name */
const fixture = (name) =>
  JSON.parse(
    readFileSync(new URL(`fixtures/agent-providers/${name}.json`, import.meta.url), "utf8"),
  );

const KEY = "sk-test-0123456789abcdefa1b2";
const TOOLS = [
  {
    name: "vimma_open",
    description: "Open a URL.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
];
const anthropic = {
  kind: "anthropic",
  endpoint: "https://api.anthropic.com/",
  model: "claude-sonnet-4-5",
};
const local = { kind: "openai", endpoint: "http://127.0.0.1:11434/v1", model: "qwen2.5:1.5b" };

/** @type {import("../src/agent-providers.mjs").ChatMessage[]} */
const HISTORY = [
  { role: "user", text: "Open the shop" },
  {
    role: "assistant",
    text: "Opening it.",
    toolCalls: [{ id: "c1", name: "vimma_open", args: { url: "https://shop.example/" } }],
  },
  {
    role: "tool",
    results: [
      {
        id: "c1",
        name: "vimma_open",
        isError: false,
        content: [
          { type: "text", text: "Opened tab 12" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ],
      },
    ],
  },
  { role: "user", text: "Lactose-free milk only" },
];

describe("Anthropic requests", () => {
  test("an Anthropic request carries the tools, the system text and the key header only", () => {
    const req = buildRequest(anthropic, { key: KEY, system: "SYS", tools: TOOLS, messages: [] });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    });
    const body = JSON.parse(req.body);
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.system).toBe("SYS");
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.tools).toEqual([
      { name: "vimma_open", description: "Open a URL.", input_schema: TOOLS[0].inputSchema },
    ]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(req.body).not.toContain(KEY);
  });

  test("messages map to text, tool_use and tool_result blocks, images included", () => {
    const body = JSON.parse(
      buildRequest(anthropic, { key: KEY, system: "S", tools: TOOLS, messages: HISTORY }).body,
    );
    expect(body.messages).toEqual([
      { role: "user", content: "Open the shop" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Opening it." },
          {
            type: "tool_use",
            id: "c1",
            name: "vimma_open",
            input: { url: "https://shop.example/" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            is_error: false,
            content: [
              { type: "text", text: "Opened tab 12" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
              },
            ],
          },
        ],
      },
      { role: "user", content: "Lactose-free milk only" },
    ]);
  });

  test("an assistant turn from Anthropic is sent back as it came, thinking blocks included", () => {
    const reply = parseReply(anthropic, fixture("anthropic-tool-use"), "");
    const body = JSON.parse(
      buildRequest(anthropic, {
        key: KEY,
        system: "S",
        tools: TOOLS,
        messages: [{ role: "user", text: "go" }, reply.message],
      }).body,
    );
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: fixture("anthropic-tool-use").content,
    });
  });

  test("tool calls, text and usage are read from an Anthropic reply", () => {
    const reply = parseReply(anthropic, fixture("anthropic-tool-use"), "");
    expect(reply.message).toMatchObject({
      role: "assistant",
      text: "I will open the shop first.",
      toolCalls: [
        {
          id: "toolu_01A09q90qw90lq917835lq9",
          name: "vimma_open",
          args: { url: "https://shop.example/" },
        },
      ],
    });
    // Cache writes and reads are input tokens too.
    expect(reply.usage).toEqual({ input: 2095 + 4100, output: 503, estimated: false });

    const end = parseReply(anthropic, fixture("anthropic-end-turn"), "");
    expect(end.message.text).toBe("The basket holds the milk.\nShall I go on?");
    expect(end.message.toolCalls).toEqual([]);
    expect(end.usage).toEqual({ input: 120 + 6195, output: 14, estimated: false });
  });
});

describe("OpenAI-compatible requests", () => {
  test("an OpenAI-compatible request maps tools to functions", () => {
    const req = buildRequest(local, { key: "", system: "SYS", tools: TOOLS, messages: [] });
    expect(req.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(req.headers).toEqual({ "content-type": "application/json" });
    const body = JSON.parse(req.body);
    expect(body.model).toBe("qwen2.5:1.5b");
    expect(body.messages).toEqual([{ role: "system", content: "SYS" }]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "vimma_open",
          description: "Open a URL.",
          parameters: TOOLS[0].inputSchema,
        },
      },
    ]);
  });

  test("a key goes in a bearer header and nowhere else", () => {
    const req = buildRequest(
      { ...local, endpoint: "https://llm.example/v1/" },
      { key: KEY, system: "S", tools: TOOLS, messages: HISTORY },
    );
    expect(req.url).toBe("https://llm.example/v1/chat/completions");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.body).not.toContain(KEY);
  });

  test("messages map to tool_calls and tool messages; images follow as a user message", () => {
    const body = JSON.parse(
      buildRequest(local, { key: "", system: "S", tools: TOOLS, messages: HISTORY }).body,
    );
    expect(body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "Open the shop" },
      {
        role: "assistant",
        content: "Opening it.",
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "vimma_open", arguments: '{"url":"https://shop.example/"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "Opened tab 12" },
      {
        role: "user",
        content: [
          { type: "text", text: "The image from vimma_open (c1):" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
      { role: "user", content: "Lactose-free milk only" },
    ]);
  });

  test("an error result says so in the tool message", () => {
    const body = JSON.parse(
      buildRequest(local, {
        key: "",
        system: "S",
        tools: TOOLS,
        messages: [
          {
            role: "tool",
            results: [
              {
                id: "c2",
                name: "vimma_open",
                isError: true,
                content: [{ type: "text", text: "denied" }],
              },
            ],
          },
        ],
      }).body,
    );
    expect(body.messages[1]).toEqual({
      role: "tool",
      tool_call_id: "c2",
      content: "Error: denied",
    });
  });

  test("tool calls and usage are read from a recorded Ollama reply", () => {
    const reply = parseReply(local, fixture("ollama-tool-call"), "");
    expect(reply.message).toEqual({
      role: "assistant",
      text: "",
      toolCalls: [
        {
          id: "call_cdtchjpp",
          name: "vimma_open",
          // qwen2.5:1.5b wrapped the URL in a schema-like object: the loop refuses it, not the
          // adapter.
          args: { url: { type: "string", value: "https://example.com" } },
        },
      ],
    });
    expect(reply.usage).toEqual({ input: 150, output: 34, estimated: false });

    const text = parseReply(local, fixture("ollama-text"), "");
    expect(text.message).toEqual({ role: "assistant", text: "Hello world!", toolCalls: [] });
    expect(text.usage).toEqual({ input: 35, output: 4, estimated: false });
  });

  test("a reply without usage counts characters, marked as an estimate", () => {
    const request = "x".repeat(401);
    const reply = parseReply(local, fixture("openai-no-usage"), request);
    expect(reply.usage.estimated).toBe(true);
    expect(reply.usage.input).toBe(101);
    const replyChars = JSON.stringify(fixture("openai-no-usage").choices[0].message).length;
    expect(reply.usage.output).toBe(Math.ceil(replyChars / 4));
  });

  test("arguments as an object are taken; broken JSON and missing ids are marked", () => {
    const reply = parseReply(local, fixture("openai-no-usage"), "");
    expect(reply.message.toolCalls).toEqual([
      { id: "call_1", name: "vimma_tabs", args: {} },
      {
        id: "call_2",
        name: "vimma_read_page",
        args: null,
        error: "its arguments are not valid JSON",
      },
    ]);
  });

  test("arguments that are JSON but not an object are marked", () => {
    const reply = parseReply(
      local,
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "a", function: { name: "vimma_tabs", arguments: "[1]" } }],
            },
          },
        ],
      },
      "",
    );
    expect(reply.message.toolCalls[0]).toMatchObject({
      args: null,
      error: "its arguments are not a JSON object",
    });
  });
});

describe("replies that are not replies", () => {
  test.each([
    ["anthropic", {}],
    ["anthropic", { content: "text" }],
    ["openai", {}],
    ["openai", { choices: [] }],
    ["openai", null],
  ])("%s reply %j is a provider error", (kind, json) => {
    const p = kind === "anthropic" ? anthropic : local;
    expect(() => parseReply(p, json, "")).toThrow(ProviderError);
  });
});

describe("errors", () => {
  test("a provider error is cut and never contains the key", () => {
    const echoed = `invalid x-api-key: ${KEY} ` + "y".repeat(400);
    const text = providerErrorText(401, echoed, KEY);
    expect(text).not.toContain(KEY);
    expect(text).toContain("•••");
    expect(text.startsWith("401: invalid x-api-key: •••")).toBe(true);
    expect([...text].length).toBeLessThanOrEqual(200);
    expect(text.endsWith("…")).toBe(true);
  });

  test("a key cut at the limit leaves no part of it", () => {
    const echoed = "z".repeat(190) + KEY;
    const text = providerErrorText(400, echoed, KEY);
    expect(text).not.toContain(KEY.slice(0, 6));
  });

  test("with no key nothing is replaced", () => {
    expect(providerErrorText(500, "overloaded", "")).toBe("500: overloaded");
  });
});

describe("callModel", () => {
  test("posts to the endpoint without credentials or redirects, and parses the reply", async () => {
    /** @type {any[]} */
    const calls = [];
    const signal = new AbortController().signal;
    /** @type {any} */
    const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify(fixture("ollama-text")) };
    };
    const reply = await callModel(local, {
      fetch,
      key: "",
      system: "S",
      tools: TOOLS,
      messages: [{ role: "user", text: "hi" }],
      signal,
    });
    expect(reply.message.text).toBe("Hello world!");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(calls[0].init).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal,
    });
  });

  test("an HTTP error is a ProviderError without the key", async () => {
    /** @type {any} */
    const fetch = async () => ({ ok: false, status: 401, text: async () => `bad key ${KEY}` });
    const call = callModel(anthropic, { fetch, key: KEY, system: "", tools: [], messages: [] });
    await expect(call).rejects.toThrow(ProviderError);
    await expect(call).rejects.toThrow("401: bad key •••");
  });

  test("a reply that is not JSON is a ProviderError", async () => {
    /** @type {any} */
    const fetch = async () => ({ ok: true, status: 200, text: async () => "<html>" });
    await expect(
      callModel(local, { fetch, key: "", system: "", tools: [], messages: [] }),
    ).rejects.toThrow(/not JSON/);
  });

  test("a refused endpoint makes no request", async () => {
    let called = false;
    /** @type {any} */
    const fetch = async () => {
      called = true;
    };
    await expect(
      callModel(
        { ...local, endpoint: "http://llm.example/v1" },
        { fetch, key: "", system: "", tools: [], messages: [] },
      ),
    ).rejects.toThrow(ProviderError);
    expect(called).toBe(false);
  });
});

describe("checkEndpoint (B11, Behaviour 9)", () => {
  test.each([
    ["https://api.anthropic.com", false, null],
    ["http://127.0.0.1:11434/v1", false, null],
    ["http://localhost:1234/v1", false, null],
    ["http://[::1]:8080/v1", false, null],
    ["http://127.0.0.1:8000/v1", true, null],
    ["http://llm.example/v1", false, "an endpoint that is not on this machine must be https://"],
    ["https://api.anthropic.com", true, "local_only refuses api.anthropic.com"],
    ["ftp://127.0.0.1/", false, "an endpoint must be an http:// or https:// address"],
    ["not a url", false, "an endpoint must be an http:// or https:// address"],
    ["https://user:pw@llm.example/", false, "an endpoint must not carry a user name or password"],
    ["https://llm.example/v1?x=1", false, "an endpoint must not carry a query or a fragment"],
    ["https://llm.example/v1#x", false, "an endpoint must not carry a query or a fragment"],
  ])("%s (local_only %s)", (endpoint, localOnly, error) => {
    expect(checkEndpoint(endpoint, { localOnly })).toBe(error);
  });

  test("an endpoint with a query or a fragment is refused", () => {
    for (const e of ["https://llm.example/v1?k=v", "https://llm.example/v1#top"])
      expect(checkEndpoint(e, { localOnly: false })).toMatch(/query or a fragment/);
  });
});

describe("edge shapes", () => {
  /** @type {import("../src/agent-providers.mjs").ChatMessage[]} */
  const odd = [
    { role: "user", text: "go" },
    // A call whose arguments were broken goes back with empty arguments, beside its error.
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "b", name: "vimma_tabs", args: null, error: "x" }],
    },
    { role: "tool", results: [{ id: "b", name: "vimma_tabs", isError: true, content: [] }] },
    // A turn in which the model wrote nothing: Anthropic refuses an empty assistant message.
    { role: "assistant", text: "", toolCalls: [] },
  ];

  test("Anthropic: an endpoint ending in /v1, maxOutput, broken and empty turns", () => {
    const req = buildRequest(
      { ...anthropic, endpoint: "https://proxy.example/v1", maxOutput: 1024 },
      { key: KEY, system: "S", tools: [], messages: odd },
    );
    expect(req.url).toBe("https://proxy.example/v1/messages");
    const body = JSON.parse(req.body);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "b", name: "vimma_tabs", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "b", is_error: true, content: [] }],
      },
    ]);
  });

  test("OpenAI-compatible: maxOutput, broken and empty turns", () => {
    const body = JSON.parse(
      buildRequest({ ...local, maxOutput: 512 }, { key: "", system: "S", tools: [], messages: odd })
        .body,
    );
    expect(body.max_tokens).toBe(512);
    expect(body.messages.slice(1)).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "b", type: "function", function: { name: "vimma_tabs", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "b", content: "Error: " },
      { role: "assistant", content: "" },
    ]);
  });

  test("Anthropic replies without usage or stop reason, and with partial usage", () => {
    const bare = parseReply(
      anthropic,
      { content: [{ type: "tool_use", id: "t", name: "vimma_tabs", input: "x" }] },
      "x".repeat(8),
    );
    expect(bare.stop).toBe("");
    expect(bare.usage).toMatchObject({ input: 2, estimated: true });
    expect(bare.message.toolCalls).toEqual([
      { id: "t", name: "vimma_tabs", args: null, error: "its arguments are not a JSON object" },
    ]);
    const partial = parseReply(anthropic, { content: [], usage: { input_tokens: 7 } }, "");
    expect(partial.usage).toEqual({ input: 7, output: 0, estimated: false });
  });

  test("OpenAI-compatible replies with partial usage, no name, empty arguments", () => {
    const reply = parseReply(
      local,
      {
        choices: [
          { message: { content: null, tool_calls: [{ id: "e", function: { arguments: "  " } }] } },
        ],
        usage: { prompt_tokens: 9 },
      },
      "",
    );
    expect(reply.usage).toEqual({ input: 9, output: 0, estimated: false });
    expect(reply.stop).toBe("");
    expect(reply.message).toEqual({
      role: "assistant",
      text: "",
      toolCalls: [{ id: "e", name: "", args: {} }],
    });
  });
});
