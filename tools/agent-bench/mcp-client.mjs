/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The bench's MCP client: `vimma-ctl mcp` over stdio, one process per run, so each run is one
// gate connection with its own grant, as each conversation will be (B5).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PROTOCOL = "2025-11-25";

export class McpClient {
  /** @param {{ bin: string, profile: string }} o */
  constructor({ bin, profile }) {
    this.child = spawn(bin, ["--profile", profile, "mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    this.nextId = 0;
    /** @type {Map<number, (m: any) => void>} */
    this.waiting = new Map();
    this.stderr = "";
    /** @type {number | null} */
    this.exitCode = null;
    this.child.stdin.on("error", () => {});
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      const done = this.waiting.get(m?.id);
      if (done) {
        this.waiting.delete(m.id);
        done(m);
      }
    });
    this.child.on("exit", (code) => {
      this.exitCode = code ?? -1;
      for (const done of this.waiting.values())
        done({ error: { message: `vimma-ctl mcp exited (${code}): ${this.stderr.trim()}` } });
      this.waiting.clear();
    });
  }

  /** @param {string} method @param {any} [params] @returns {Promise<any>} the response */
  request(method, params) {
    const id = ++this.nextId;
    const reply = new Promise((resolve) => this.waiting.set(id, resolve));
    this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return reply;
  }

  /** @param {any} message */
  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async initialize() {
    const r = await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "vimma-agent-bench", version: "1" },
    });
    if (r.error) throw new Error(`MCP initialize failed: ${r.error.message}`);
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r.result;
  }

  /**
   * One tool call as the loop's runner: MCP's CallToolResult, a protocol error as an error
   * result. A stop withdraws a call still waiting for the user (MCP's cancellation).
   * @param {string} name @param {Record<string, any>} args @param {{ signal?: AbortSignal }} [o]
   * @returns {Promise<{ content: any[], isError: boolean }>}
   */
  async callTool(name, args, { signal } = {}) {
    const id = this.nextId + 1;
    const onAbort = () =>
      this.write({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, reason: "the task was stopped" },
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await this.request("tools/call", { name, arguments: args });
      if (r.error)
        return { isError: true, content: [{ type: "text", text: String(r.error.message) }] };
      return { content: r.result?.content ?? [], isError: !!r.result?.isError };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Closes stdin, as an agent host does when it is done; the connection and its grant end. */
  async close() {
    this.child.stdin.end();
    if (this.exitCode !== null) return;
    await Promise.race([
      new Promise((r) => this.child.once("exit", r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    if (this.exitCode === null) this.child.kill("SIGKILL");
  }
}
