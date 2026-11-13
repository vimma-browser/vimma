// A fake Vimma control server speaking protocol v1 (spec m0-control-protocol-and-vimma-ctl),
// for the harness's tests. Every line it receives and sends is checked with vimma-core's
// validateMessage, the validator the real server will use, so a drift from the contract
// fixtures fails here first. Behaviour switches simulate the failures the driver must handle.
import { createHmac, randomBytes } from "node:crypto";
import { rmSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  CHALLENGE_CONTEXT,
  tokensEqual,
  validateMessage,
} from "../../../packages/vimma-core/src/control.mjs";

/**
 * @typedef {{ id: string, url: string, title: string, selected: boolean }} FakeTab
 * @typedef {{
 *   busyConnections?: number,
 *   rejectAuth?: boolean,
 *   dropOn?: string,
 *   errorOn?: Record<string, string>,
 *   errorMessage?: string,
 *   errorTimes?: number,
 *   hangOn?: string,
 *   discoveryMode?: number,
 *   writeDiscovery?: boolean,
 * }} FakeOptions
 * @typedef {{
 *   port: number,
 *   token: string,
 *   discoveryPath: string,
 *   requests: Array<{ command: string, args: Record<string, unknown> }>,
 *   connections: number,
 *   state: { mode: string, pending: string | null, workspace: null, tabs: FakeTab[], panes: null },
 *   options: FakeOptions,
 *   writeDiscovery: () => void,
 *   close: (opts?: { keepFile?: boolean }) => Promise<void>,
 * }} FakeServer
 */

/**
 * Start the fake server for `profile`; it writes `<profile>/vimma-control.json` like the real one.
 * @param {string} profile
 * @param {FakeOptions} [options] mutable later through `server.options`
 * @returns {Promise<FakeServer>}
 */
export async function startFakeServer(profile, options = {}) {
  const token = randomBytes(32).toString("hex");
  const discoveryPath = join(profile, "vimma-control.json");
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  let nextTab = 2;
  /** @type {FakeServer} */
  const fake = {
    port: 0,
    token,
    discoveryPath,
    requests: [],
    connections: 0,
    state: {
      mode: "insert",
      pending: null,
      workspace: null,
      tabs: [{ id: "1", url: "about:blank", title: "", selected: true }],
      panes: null,
    },
    options,
    writeDiscovery() {
      const tmp = `${discoveryPath}.tmp`;
      const body = { protocol: 1, port: fake.port, token, pid: process.pid };
      check(body, { kind: "discovery" });
      writeFileSync(tmp, JSON.stringify(body), { mode: fake.options.discoveryMode ?? 0o600 });
      renameSync(tmp, discoveryPath);
    },
    async close({ keepFile = false } = {}) {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      if (!keepFile) rmSync(discoveryPath, { force: true });
    },
  };

  /**
   * @param {unknown} message
   * @param {import("../../../packages/vimma-core/src/control.mjs").ValidateOptions} [opts]
   */
  function check(message, opts) {
    const { valid, errors } = validateMessage(message, opts);
    if (!valid) throw new Error(`fake server broke the contract: ${errors.join("; ")}`);
  }

  /**
   * @param {string} command
   * @param {Record<string, unknown>} args
   * @returns {{ result?: object, error?: { code: string, message: string } }}
   */
  function execute(command, args) {
    const forced = fake.options.errorOn?.[command];
    // errorTimes: fail only that many times, then answer normally (a server still starting up)
    if (forced && (fake.options.errorTimes ?? Infinity) > 0) {
      fake.options.errorTimes = (fake.options.errorTimes ?? Infinity) - 1;
      return { error: { code: forced, message: fake.options.errorMessage ?? `fake ${forced}` } };
    }
    if (command === "state") return { result: structuredClone(fake.state) };
    if (command === "send-keys") {
      const chords = String(args.keys).trim().split(/\s+/);
      for (let i = 0; i < chords.length; i++) {
        const chord = chords[i];
        if (chord === "ctrl+b" && chords[i + 1] === "?") {
          fake.state.mode = fake.state.mode === "help" ? "insert" : "help";
          i++;
        } else if (chord === "esc" && fake.state.mode === "help") {
          fake.state.mode = "insert";
        }
      }
      return { result: { sent: chords.length } };
    }
    if (command === "open") {
      const id = String(nextTab++);
      for (const tab of fake.state.tabs) tab.selected = false;
      fake.state.tabs.push({ id, url: String(args.url), title: "", selected: true });
      return { result: { tab: id } };
    }
    return { error: { code: "not-implemented", message: `${command} is reserved` } };
  }

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    fake.connections++;
    /** @param {object} message @param {import("../../../packages/vimma-core/src/control.mjs").ValidateOptions} [opts] */
    const send = (message, opts) => {
      check(message, opts);
      socket.write(`${JSON.stringify(message)}\n`);
    };
    if ((fake.options.busyConnections ?? 0) > 0) {
      fake.options.busyConnections = (fake.options.busyConnections ?? 0) - 1;
      send({ type: "response", id: null, ok: false, error: { code: "busy", message: "8 open" } });
      socket.end();
      return;
    }
    let greeted = false;
    let authed = false;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line);
        if (!greeted) {
          // hello {nonce} → challenge: prove the token as the real server does.
          check(message, { kind: "hello" });
          greeted = true;
          const proof = createHmac("sha256", token)
            .update(`${CHALLENGE_CONTEXT}${message.nonce}`)
            .digest("hex");
          send({ type: "challenge", protocol: 1, proof });
          continue;
        }
        if (!authed) {
          check(message, { kind: "auth" });
          if (fake.options.rejectAuth || !tokensEqual(message.token, token)) {
            send({
              type: "response",
              id: null,
              ok: false,
              error: { code: "unauthorized", message: "bad token" },
            });
            socket.end();
            return;
          }
          authed = true;
          send({ type: "welcome", protocol: 1, app: "Vimma", version: "0.1.0" });
          continue;
        }
        check(message, { kind: "request" });
        fake.requests.push({ command: message.command, args: message.args });
        if (fake.options.hangOn === message.command) continue; // never answers
        if (fake.options.dropOn === message.command) {
          socket.destroy();
          return;
        }
        const { result, error } = execute(message.command, message.args);
        const response = error
          ? { type: "response", id: message.id, ok: false, error }
          : { type: "response", id: message.id, ok: true, result };
        send(response, { kind: "response", command: message.command });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  fake.port = typeof address === "object" && address ? address.port : 0;
  if (options.writeDiscovery !== false) fake.writeDiscovery();
  return fake;
}
