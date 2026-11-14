// The harness's own control-protocol client (docs/specs/vimma-mcp.md, sub-PR 2b), for what
// vimma-ctl's one-shot runs cannot do: a full connection held for the rest of a scenario (opened
// while MCP is off, so keys sent through it never ask), an agent connection whose requests wait
// for the user, and vimma-ctl runs that are not awaited. The handshake is the real one: the
// server proves the token before the client sends it. It also runs `vimma-ctl mcp` itself, spoken
// to over stdio as an agent tool would.
import { execFile, spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CHALLENGE_CONTEXT } from "../../packages/vimma-core/src/control.mjs";
import type { Socket } from "node:net";
import type { AgentSend, McpSend } from "./scenario.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * The version a vimma-ctl built from this tree names in its agent-hello (surfer.json's
 * displayVersion, docs/specs/ship-vimma-ctl.md), so the harness's agent connection is as new as
 * the build under test and shows no older-client notice.
 */
const CTL_VERSION = JSON.parse(readFileSync(new URL("../../surfer.json", import.meta.url), "utf8"))
  .brands.vimma.release.displayVersion;

/** How long a request may wait for the user (the longest ask_timeout plus 10 s). */
const ANSWER_MS = 310_000;

export class ControlClient {
  declare socket: Socket;
  declare buffer: string;
  declare messages: any[];
  declare waiters: Array<() => void>;
  declare closed: boolean;
  declare nextId: number;
  constructor(socket: Socket) {
    this.socket = socket;
    this.buffer = "";
    this.messages = [];
    this.waiters = [];
    this.closed = false;
    this.nextId = 0;
    socket.setEncoding("utf8");
    socket.on("data", (d) => {
      this.buffer += d;
      let nl;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        this.messages.push(JSON.parse(this.buffer.slice(0, nl)));
        this.buffer = this.buffer.slice(nl + 1);
      }
      this.wake();
    });
    socket.on("close", () => {
      this.closed = true;
      this.wake();
    });
    socket.on("error", () => {});
  }

  static async connect({
    port,
    token,
    role,
  }: {
    port: number;
    token: string;
    role: "full" | "agent";
  }) {
    const socket = connect({ host: "127.0.0.1", port });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const c = new ControlClient(socket);
    const nonce = randomBytes(32).toString("hex");
    c.send({ type: "hello", protocol: 2, role, nonce });
    const challenge = await c.take();
    const expected = createHmac("sha256", token)
      .update(CHALLENGE_CONTEXT + nonce)
      .digest("hex");
    const proof = Buffer.from(String(challenge?.proof ?? ""));
    if (
      challenge?.type !== "challenge" ||
      proof.length !== expected.length ||
      !timingSafeEqual(proof, Buffer.from(expected))
    ) {
      c.close();
      throw new Error(`the server did not prove it knows the token: ${JSON.stringify(challenge)}`);
    }
    c.send({ type: "auth", token });
    const welcome = await c.take(ANSWER_MS);
    if (welcome?.type !== "welcome") {
      c.close();
      throw new Error(`no welcome: ${JSON.stringify(welcome)}`);
    }
    return c;
  }

  wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** The next message matching `pred`, or null once closed or after `ms`. */
  async take(ms: number = 10_000, pred: (m: any) => boolean = () => true) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.messages.findIndex(pred);
      if (i !== -1) return this.messages.splice(i, 1)[0];
      const left = deadline - Date.now();
      if (this.closed || left <= 0) return null;
      await new Promise((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve(undefined);
        });
      });
    }
  }

  send(message: object) {
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  /** Send a request; its id. */
  request(command: string, args: object) {
    const id = ++this.nextId;
    this.send({ type: "request", id, command, args });
    return id;
  }

  response(id: number, ms: number = ANSWER_MS) {
    return this.take(ms, (m) => m.type === "response" && m.id === id);
  }

  call(command: string, args: object) {
    return this.response(this.request(command, args));
  }

  close() {
    this.socket.destroy();
  }
}

/** One scenario's connections and vimma-ctl runs. */
export class ControlSessions {
  declare profile: string;
  declare bin: string;
  declare signal: AbortSignal | undefined;
  declare full: ControlClient | null;
  declare agent: Promise<ControlClient> | null;
  declare pending: Map<string, Promise<unknown>>;
  declare runs: Map<string, Promise<{ exitCode: number | null; stderr: string }>>;
  declare mcp: McpProcess | null;
  declare held: {
    state: () => Promise<any>;
    sendKeys: (keys: string) => Promise<void>;
    open: (url: string) => Promise<string>;
  };
  constructor({ profile, bin, signal }: { profile: string; bin: string; signal?: AbortSignal }) {
    this.profile = profile;
    this.bin = bin;
    this.signal = signal;
    this.full = null;
    this.agent = null;
    this.pending = new Map();
    this.runs = new Map();
    this.mcp = null;
    const self = this;
    this.held = {
      state: async () => self.result(await self.heldCall("state", {})),
      sendKeys: async (keys: string) => {
        self.result(await self.heldCall("send-keys", { keys }));
      },
      open: async (url: string) =>
        String((self.result(await self.heldCall("open", { url })) as any).tab),
    };
  }

  discovery() {
    return JSON.parse(readFileSync(join(this.profile, "vimma-control.json"), "utf8"));
  }

  /** Keep one full connection; while MCP is off, it is welcomed without a question. */
  async hold() {
    const { port, token } = this.discovery();
    this.full = await ControlClient.connect({ port, token, role: "full" });
  }

  async heldCall(command: string, args: object) {
    if (!this.full) throw new Error("no held connection");
    return this.full.call(command, args);
  }

  result(reply: any) {
    if (!reply) throw new Error("the held connection closed");
    if (!reply.ok) throw new Error(`${reply.error?.code}: ${reply.error?.message}`);
    return reply.result;
  }

  agentSend(spec: AgentSend) {
    this.agent ??= (async () => {
      const { port, token } = this.discovery();
      const c = await ControlClient.connect({ port, token, role: "agent" });
      const hi = await c.call("agent-hello", {
        client: { name: spec.client ?? "example-agent" },
        ctl: CTL_VERSION,
      });
      if (!hi?.ok) throw new Error(`agent-hello: ${JSON.stringify(hi)}`);
      return c;
    })();
    const agent = this.agent;
    this.pending.set(
      spec.as,
      agent.then((c) => c.call(spec.send, spec.args ?? {})),
    );
  }

  async agentResult(name: string) {
    const p = this.pending.get(name);
    if (!p) throw new Error(`no agent request named ${name}`);
    return p;
  }

  ctlSpawn(args: string[], as: string) {
    this.runs.set(
      as,
      new Promise((resolve) => {
        execFile(
          this.bin,
          ["--profile", this.profile, "--timeout", "5", ...args],
          { encoding: "utf8", timeout: ANSWER_MS, signal: this.signal, killSignal: "SIGKILL" },
          (error, _stdout, stderr) => {
            const code = error && typeof error.code === "number" ? error.code : error ? null : 0;
            resolve({ exitCode: code, stderr });
          },
        );
      }),
    );
  }

  async ctlResult(name: string) {
    const p = this.runs.get(name);
    if (!p) throw new Error(`no ctl run named ${name}`);
    return p;
  }

  /** `vimma-ctl mcp`, spawned at the first mcp step and kept for the scenario. */
  mcpProcess() {
    if (this.mcp) return this.mcp;
    const child = spawn(this.bin, ["--profile", this.profile, "mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.signal ? { signal: this.signal } : {}),
      killSignal: "SIGKILL",
    });
    const p: McpProcess = {
      child,
      nextId: 0,
      ids: new Map(),
      replies: new Map(),
      bad: [],
      stderr: "",
      exitCode: undefined,
      waiters: [],
    };
    const wake = () => {
      for (const w of p.waiters.splice(0)) w();
    };
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (p.stderr += d));
    // Nothing but whole JSON-RPC messages may reach stdout (MCP stdio; spec M9).
    createInterface({ input: child.stdout }).on("line", (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        m = null;
      }
      if (m?.jsonrpc !== "2.0") p.bad.push(line);
      else if (m.id !== undefined && m.id !== null) p.replies.set(m.id, m);
      wake();
    });
    child.on("exit", (code) => {
      p.exitCode = code;
      wake();
    });
    this.mcp = p;
    return p;
  }

  /** Send one JSON-RPC message; a request when `as` names its answer. */
  mcpSend({ method, params, as }: McpSend) {
    const p = this.mcpProcess();
    const message: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
      ...(params ? { params } : {}),
    };
    if (as) {
      const id = ++p.nextId;
      p.ids.set(as, id);
      message.id = id;
    }
    p.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** The response to the request named `name`, once it comes (a call waits for the user). */
  async mcpResult(name: string) {
    const p = this.mcp;
    const id = p?.ids.get(name);
    if (!p || id === undefined) throw new Error(`no mcp request named ${name}`);
    const deadline = Date.now() + ANSWER_MS;
    for (;;) {
      if (p.bad.length) throw new Error(`vimma-ctl mcp wrote a non-message: ${p.bad[0]}`);
      const reply = p.replies.get(id);
      if (reply) return reply;
      if (p.exitCode !== undefined) {
        throw new Error(`vimma-ctl mcp exited (${p.exitCode}) before answering: ${p.stderr}`);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`vimma-ctl mcp did not answer ${name}`);
      await new Promise((resolve) => {
        const t = setTimeout(resolve, left);
        p.waiters.push(() => {
          clearTimeout(t);
          resolve(undefined);
        });
      });
    }
  }

  /** Close stdin, as an agent tool does when it is done; how it ended. */
  async mcpClose() {
    const p = this.mcp;
    if (!p) return null;
    this.mcp = null;
    p.child.stdin.end();
    const deadline = Date.now() + 5000;
    while (p.exitCode === undefined && Date.now() < deadline) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 100);
        p.waiters.push(() => {
          clearTimeout(t);
          resolve(undefined);
        });
      });
    }
    if (p.exitCode === undefined) p.child.kill("SIGKILL");
    return { exitCode: p.exitCode ?? null, stdoutClean: p.bad.length === 0, stderr: p.stderr };
  }

  close() {
    this.full?.close();
    this.agent?.then((c) => c.close()).catch(() => {});
    if (this.mcp) {
      const { child } = this.mcp;
      this.mcp = null;
      child.stdin.end();
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }
  }
}

export type McpProcess = {
  child: ChildProcessWithoutNullStreams;
  nextId: number;
  ids: Map<string, number>;
  replies: Map<unknown, any>;
  bad: string[];
  stderr: string;
  exitCode: number | null | undefined;
  waiters: Array<() => void>;
};
