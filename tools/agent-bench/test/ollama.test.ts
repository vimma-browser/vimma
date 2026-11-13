import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpFetch } from "../http-fetch.mjs";
import { ctxModelName, describe as describeModel, ollamaRoot, withContext } from "../ollama.mjs";

/** @type {Array<{ method: string, url: string, body: any }>} */
const seen = [];
/** @type {import("node:http").Server} */
let server;
let root = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: body ? JSON.parse(body) : null,
      });
      const json = (/** @type {any} */ v) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.url === "/api/version") return json({ version: "0.40.12" });
      if (req.url === "/api/create") return json({ status: "success" });
      if (req.url === "/api/show")
        return json({
          parameters: "stop <|im_end|>\nnum_ctx 32768",
          details: { parameter_size: "7.6B", quantization_level: "Q4_K_M", family: "qwen2" },
          model_info: { "qwen2.context_length": 32768 },
        });
      if (req.url === "/moved") {
        res.writeHead(302, { location: "/api/version" });
        return res.end();
      }
      res.writeHead(404).end("no");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const a = server.address();
  root = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterAll(() => new Promise((r) => server.close(() => r(undefined))));

describe("ollama", () => {
  it("finds the server's root from its OpenAI-compatible endpoint", () => {
    expect(ollamaRoot("http://127.0.0.1:11434/v1")).toBe("http://127.0.0.1:11434");
    expect(ollamaRoot("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
  });

  it("names the model with a context length after the original", () => {
    expect(ctxModelName("qwen2.5:7b", 32768)).toBe("qwen2.5:7b-ctx32768");
    expect(ctxModelName("llama3", 8192)).toBe("llama3:latest-ctx8192");
  });

  it("makes that model from the original with num_ctx set", async () => {
    const name = await withContext(`${root}/v1`, "qwen2.5:7b", 32768);
    expect(name).toBe("qwen2.5:7b-ctx32768");
    expect(seen.at(-1)).toEqual({
      method: "POST",
      url: "/api/create",
      body: {
        model: "qwen2.5:7b-ctx32768",
        from: "qwen2.5:7b",
        parameters: { num_ctx: 32768 },
        stream: false,
      },
    });
  });

  it("describes the server and the model for the results", async () => {
    expect(await describeModel(`${root}/v1`, "qwen2.5:7b-ctx32768")).toEqual({
      server: "Ollama 0.40.12",
      parameters: "7.6B",
      quantisation: "Q4_K_M",
      family: "qwen2",
      numCtx: 32768,
      trainedCtx: 32768,
    });
  });
});

describe("httpFetch", () => {
  it("posts and reads a body", async () => {
    const res = await httpFetch(`${root}/api/version`, { method: "GET" });
    expect(res.ok).toBe(true);
    expect(JSON.parse(await res.text())).toEqual({ version: "0.40.12" });
  });

  it("follows no redirect", async () => {
    await expect(httpFetch(`${root}/moved`, { method: "GET" })).rejects.toThrow(/redirect/);
  });

  it("stops at the abort signal", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      httpFetch(`${root}/api/version`, { method: "GET", signal: abort.signal }),
    ).rejects.toThrow();
  });
});
