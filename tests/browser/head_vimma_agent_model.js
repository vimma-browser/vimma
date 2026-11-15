/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The built-in agent's scripted model (docs/specs/builtin-agent.md): an OpenAI-compatible
// server on 127.0.0.1 in the test's process, shared by the agent's browser tests. Loaded with
// loadSubScript; stops when the test ends.

"use strict";

/* exported requests, held, PORT, PROVIDER, script, openStep */
/* global NetUtil -- the browser-chrome harness (browser-test.js) */

const { HttpServer } = ChromeUtils.importESModule("resource://testing-common/httpd.sys.mjs");

/**
 * A message of a request to the model, in OpenAI's shape; an Anthropic request's `content` is a
 * string or a list of blocks.
 * @typedef {{ role: string, content?: unknown }} ModelMessage
 */
/**
 * A request's JSON body: the model it asks for and the conversation so far.
 * @typedef {{ model?: string, messages: ModelMessage[] }} ModelRequestBody
 */
/**
 * A step of a script (see chatCompletions).
 * @typedef {{ call?: string, args?: Record<string, unknown>, say?: string, reply?: string,
 *   hold?: boolean }} ScriptStep
 */

/**
 * What the scripted model was sent: path, the headers that matter, and the body (null for the
 * paths that only record that they were asked).
 * @type {{ path: string, cookie: string | null, authorization: string | null,
 *   body: ModelRequestBody | null, apiKey?: string | null }[]}
 */
const requests = [];
/** Replies held back until the test releases them, by the task text that asked. */
/** @type {Map<string, () => void>} */
const held = new Map();
/** @type {nsIHttpServer} */
const server = new HttpServer();

/**
 * The scripted model. A task is `SCRIPT:` and a JSON list of steps: `{ call, args }` for a tool
 * call (with `say`, the text that comes with it), `{ reply }` for a reply, `{ hold: true }` to
 * wait until the test releases it. Step n answers the model's n-th turn after the task's
 * message. In args, `$tab` is the last tab id a tool result named, and `$label:Words` the label
 * of the element with those words in the last element list. It answers in OpenAI's chat
 * completions format, or in Anthropic's Messages format (`anthropic`), whose requests it reads
 * into the same shape first.
 */
function chatCompletions(/** @type {nsIHttpRequest} */ req, /** @type {nsIHttpResponse} */ res) {
  scripted(req, res, "openai");
}

/** Anthropic's Messages API, as the scripted model. */
function anthropicMessages(/** @type {nsIHttpRequest} */ req, /** @type {nsIHttpResponse} */ res) {
  scripted(req, res, "anthropic");
}

/**
 * An Anthropic request's messages in OpenAI's shape: a tool result block becomes a `tool`
 * message with its text.
 * @param {ModelMessage[]} messages
 * @returns {ModelMessage[]}
 */
const fromAnthropic = (messages) =>
  messages.flatMap((m) => {
    if (m.role === "assistant") return [{ role: "assistant" }];
    if (typeof m.content === "string") return [{ role: "user", content: m.content }];
    // Anthropic's other content is a list of blocks.
    return /** @type {{ type: string, content?: unknown }[]} */ (m.content)
      .filter((b) => b.type === "tool_result")
      .map((b) => ({
        role: "tool",
        content: (Array.isArray(b.content) ? b.content : [{ text: String(b.content) }])
          .map((/** @type {{ text?: string }} */ c) => c.text ?? "")
          .join("\n"),
      }));
  });

/**
 * @param {nsIHttpRequest} req @param {nsIHttpResponse} res @param {"openai" | "anthropic"} format
 */
function scripted(req, res, format) {
  const stream = req.bodyInputStream;
  /** @type {ModelRequestBody} */
  const body = JSON.parse(NetUtil.readInputStreamToString(stream, stream.available()));
  const header = (/** @type {string} */ h) => (req.hasHeader(h) ? req.getHeader(h) : null);
  requests.push({
    path: req.path,
    cookie: header("Cookie"),
    authorization: header("Authorization"),
    apiKey: header("x-api-key"),
    body,
  });
  const messages = format === "anthropic" ? fromAnthropic(body.messages) : body.messages;
  const at = messages.findLastIndex(
    (m) => m.role === "user" && String(m.content).startsWith("SCRIPT:"),
  );
  // The task's text: findLastIndex matched it as a string that starts with SCRIPT:.
  const task = String(messages[at].content);
  /** @type {ScriptStep[]} */
  const script = JSON.parse(task.slice("SCRIPT:".length));
  const after = messages.slice(at + 1);
  const step = script[after.filter((m) => m.role === "assistant").length] ?? { reply: "done" };
  const results = after.filter((m) => m.role === "tool").map((m) => String(m.content));
  const resolve = (/** @type {unknown} */ v) => {
    if (typeof v !== "string") return v;
    if (v === "$tab") {
      const ids = results.flatMap((t) => [...t.matchAll(/\btab (\d+)\b/g)].map((m) => m[1]));
      return ids.at(-1) ?? "0";
    }
    if (v.startsWith("$label:")) {
      const words = JSON.stringify(v.slice("$label:".length));
      const line = results
        .flatMap((t) => t.split("\n"))
        .findLast((l) => l.includes(words) && l.includes('"label"'));
      return /"label":"(\w+)"/.exec(line ?? "")?.[1] ?? "zz";
    }
    return v;
  };
  const args = () =>
    Object.fromEntries(Object.entries(step.args ?? {}).map(([k, v]) => [k, resolve(v)]));
  const send = () => {
    res.setHeader("Content-Type", "application/json", false);
    if (format === "anthropic") {
      res.write(
        JSON.stringify({
          content: step.call
            ? [{ type: "tool_use", id: `toolu_${after.length}`, name: step.call, input: args() }]
            : [{ type: "text", text: step.reply ?? "done" }],
          stop_reason: step.call ? "tool_use" : "end_turn",
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      );
      return;
    }
    const message = step.call
      ? {
          role: "assistant",
          content: step.say ?? "",
          tool_calls: [
            {
              id: `call_${after.length}`,
              type: "function",
              function: {
                name: step.call,
                arguments: JSON.stringify(args()),
              },
            },
          ],
        }
      : { role: "assistant", content: step.reply ?? "done" };
    res.write(
      JSON.stringify({
        choices: [{ message, finish_reason: step.call ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    );
  };
  if (step.hold) {
    res.processAsync();
    held.set(task, () => {
      send();
      res.finish();
    });
    return;
  }
  send();
}

server.registerPathHandler("/v1/chat/completions", chatCompletions);
server.registerPathHandler("/anthropic/v1/messages", anthropicMessages);
server.registerPathHandler("/v1/models", (_req, res) => {
  res.setHeader("Content-Type", "application/json", false);
  res.write(JSON.stringify({ data: [{ id: "scripted" }, { id: "scripted-2" }] }));
});
// A server that sends the request elsewhere: the agent's requests must not follow it (B11).
server.registerPathHandler("/moved/v1/chat/completions", (req, res) => {
  requests.push({ path: req.path, cookie: null, authorization: null, body: null });
  res.setStatusLine(req.httpVersion, 307, "Temporary Redirect");
  res.setHeader("Location", "/v1/chat/completions", false);
});
server.registerPathHandler("/elsewhere", (req) => {
  requests.push({ path: req.path, cookie: null, authorization: null, body: null });
});
server.start(-1);
const PORT = server.identity.primaryPort;
const PROVIDER = {
  name: "scripted",
  kind: /** @type {"openai"} */ ("openai"),
  endpoint: `http://127.0.0.1:${PORT}/v1`,
  model: "scripted",
  vision: false,
};

/** @param {ScriptStep[]} steps */
const script = (steps) => `SCRIPT:${JSON.stringify(steps)}`;
const openStep = (/** @type {string} */ url) => ({ call: "vimma_open", args: { url } });

registerCleanupFunction(() => new Promise((resolve) => server.stop(() => resolve(undefined))));
