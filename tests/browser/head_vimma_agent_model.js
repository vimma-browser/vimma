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

/** What the scripted model was sent: path, the headers that matter, and the body. */
/** @type {{ path: string, cookie: string | null, authorization: string | null, body: any }[]} */
const requests = [];
/** Replies held back until the test releases them, by the task text that asked. */
/** @type {Map<string, () => void>} */
const held = new Map();
const server = new HttpServer();

/**
 * The scripted model. A task is `SCRIPT:` and a JSON list of steps: `{ call, args }` for a tool
 * call, `{ reply }` for a reply, `{ hold: true }` to wait until the test releases it. Step n
 * answers the model's n-th turn after the task's message. In args, `$tab` is the last tab id a
 * tool result named, and `$label:Words` the label of the element with those words in the last
 * element list.
 */
function chatCompletions(/** @type {any} */ req, /** @type {any} */ res) {
  const stream = req.bodyInputStream;
  const body = JSON.parse(NetUtil.readInputStreamToString(stream, stream.available()));
  const header = (/** @type {string} */ h) => (req.hasHeader(h) ? req.getHeader(h) : null);
  requests.push({
    path: req.path,
    cookie: header("Cookie"),
    authorization: header("Authorization"),
    body,
  });
  /** @type {any[]} */
  const messages = body.messages;
  const at = messages.findLastIndex(
    (m) => m.role === "user" && String(m.content).startsWith("SCRIPT:"),
  );
  const script = JSON.parse(messages[at].content.slice("SCRIPT:".length));
  const after = messages.slice(at + 1);
  const step = script[after.filter((m) => m.role === "assistant").length] ?? { reply: "done" };
  const results = after.filter((m) => m.role === "tool").map((m) => String(m.content));
  const resolve = (/** @type {any} */ v) => {
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
  const send = () => {
    const message = step.call
      ? {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: `call_${after.length}`,
              type: "function",
              function: {
                name: step.call,
                arguments: JSON.stringify(
                  Object.fromEntries(
                    Object.entries(step.args ?? {}).map(([k, v]) => [k, resolve(v)]),
                  ),
                ),
              },
            },
          ],
        }
      : { role: "assistant", content: step.reply ?? "done" };
    res.setHeader("Content-Type", "application/json", false);
    res.write(
      JSON.stringify({
        choices: [{ message, finish_reason: step.call ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }),
    );
  };
  if (step.hold) {
    res.processAsync();
    held.set(messages[at].content, () => {
      send();
      res.finish();
    });
    return;
  }
  send();
}

server.registerPathHandler("/v1/chat/completions", chatCompletions);
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
  kind: "openai",
  endpoint: `http://127.0.0.1:${PORT}/v1`,
  model: "scripted",
  vision: false,
};

/** @param {any[]} steps */
const script = (steps) => `SCRIPT:${JSON.stringify(steps)}`;
const openStep = (/** @type {string} */ url) => ({ call: "vimma_open", args: { url } });

registerCleanupFunction(() => new Promise((resolve) => server.stop(resolve)));
