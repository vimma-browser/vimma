// The harness's own control-protocol client (docs/specs/vimma-mcp.md, sub-PR 2b): a held full
// connection and an agent connection, against a minimal protocol 2 server here.
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHALLENGE_CONTEXT } from "../../../packages/vimma-core/src/control.mjs";
import { ControlClient, ControlSessions } from "../control-client.mjs";
import { findVimmaCtl } from "../driver.mjs";

const TOKEN = "ab".repeat(32);

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/**
 * A server that proves the token, welcomes, and answers each request with `answer(request)`.
 * @param {(m: any) => object} answer
 */
async function server(answer, { proof = TOKEN } = {}) {
  /** @type {any[]} */
  const seen = [];
  const srv = createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        seen.push(m);
        const send = (/** @type {object} */ o) => socket.write(`${JSON.stringify(o)}\n`);
        if (m.type === "hello") {
          const p = createHmac("sha256", proof)
            .update(CHALLENGE_CONTEXT + m.nonce)
            .digest("hex");
          send({ type: "challenge", protocol: 2, proof: p });
        } else if (m.type === "auth") {
          send({ type: "welcome", protocol: 2, app: "Vimma", version: "0", role: "agent" });
        } else {
          send({ type: "response", id: m.id, ok: true, result: answer(m) });
        }
      }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(undefined)));
  cleanups.push(() => srv.close());
  const port = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
  return { port, seen };
}

describe("ControlClient", () => {
  it("checks the server's proof, sends the token, then requests by id", async () => {
    const { port, seen } = await server((m) => ({ echo: m.command }));
    const c = await ControlClient.connect({ port, token: TOKEN, role: "agent" });
    expect(await c.call("agent-tabs", {})).toEqual({
      type: "response",
      id: 1,
      ok: true,
      result: { echo: "agent-tabs" },
    });
    c.close();
    expect(seen.map((m) => m.type)).toEqual(["hello", "auth", "request"]);
    expect(seen[0]).toMatchObject({ protocol: 2, role: "agent" });
  });

  it("refuses a server that cannot prove the token, before sending it", async () => {
    const { port, seen } = await server(() => ({}), { proof: "cd".repeat(32) });
    await expect(ControlClient.connect({ port, token: TOKEN, role: "full" })).rejects.toThrow(
      /did not prove/,
    );
    expect(seen.map((m) => m.type)).toEqual(["hello"]);
  });
});

describe("ControlSessions", () => {
  it("connects an agent with its hello on first use and keeps answers by name", async () => {
    const { port, seen } = await server((m) => (m.command === "agent-hello" ? {} : { tabs: [] }));
    const profile = mkdtempSync(join(tmpdir(), "vimma-e2e-cc-"));
    cleanups.push(() => rmSync(profile, { recursive: true, force: true }));
    writeFileSync(
      join(profile, "vimma-control.json"),
      JSON.stringify({ protocol: 2, port, token: TOKEN, pid: 1, roles: ["agent", "full"] }),
    );
    const sessions = new ControlSessions({ profile, bin: "/nonexistent" });
    cleanups.push(() => sessions.close());
    sessions.agentSend({ send: "agent-tabs", args: {}, as: "t1", client: "example-agent" });
    expect(await sessions.agentResult("t1")).toMatchObject({ ok: true, result: { tabs: [] } });
    const requests = seen.filter((m) => m.type === "request");
    expect(requests.map((m) => m.command)).toEqual(["agent-hello", "agent-tabs"]);
    // As the vimma-ctl built from this tree names itself, so a build shows no older-client
    // notice in an e2e screenshot (docs/specs/ship-vimma-ctl.md).
    const surfer = JSON.parse(
      readFileSync(new URL("../../../surfer.json", import.meta.url), "utf8"),
    );
    expect(requests[0].args).toEqual({
      client: { name: "example-agent" },
      ctl: surfer.brands.vimma.release.displayVersion,
    });
  });
});

/** @type {string | null} */
let bin = null;
try {
  bin = findVimmaCtl({ env: process.env });
} catch (e) {
  if (process.env.E2E_REQUIRE_CTL) throw e;
}

// docs/specs/vimma-mcp.md, sub-PR 3: the real `vimma-ctl mcp` over stdio, against the minimal
// server above (needs a built vimma-ctl; required in CI by E2E_REQUIRE_CTL).
describe.skipIf(!bin)(`ControlSessions' mcp${bin ? "" : " (skipped: no vimma-ctl built)"}`, () => {
  it("spawns vimma-ctl mcp once, and answers JSON-RPC by name", async () => {
    const { port, seen } = await server((m) =>
      m.command === "agent-hello" ? { workspace: "agent", exists: true } : { tabs: [] },
    );
    const profile = mkdtempSync(join(tmpdir(), "vimma-e2e-mcp-"));
    cleanups.push(() => rmSync(profile, { recursive: true, force: true }));
    writeFileSync(
      join(profile, "vimma-control.json"),
      JSON.stringify({ protocol: 2, port, token: TOKEN, pid: process.pid, roles: ["agent"] }),
      { mode: 0o600 },
    );
    const sessions = new ControlSessions({ profile, bin: /** @type {string} */ (bin) });
    cleanups.push(() => sessions.close());
    sessions.mcpSend({
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "e2e" } },
      as: "init",
    });
    expect(await sessions.mcpResult("init")).toMatchObject({
      jsonrpc: "2.0",
      result: { protocolVersion: "2025-11-25", serverInfo: { name: "vimma" } },
    });
    sessions.mcpSend({ method: "notifications/initialized" });
    sessions.mcpSend({ method: "tools/call", params: { name: "vimma_tabs" }, as: "tabs" });
    const tabs = /** @type {any} */ (await sessions.mcpResult("tabs"));
    expect(tabs.result.content[0].text).toMatch(/no tabs/);
    const requests = seen.filter((m) => m.type === "request").map((m) => m.command);
    expect(requests).toEqual(["agent-hello", "agent-tabs"]);
    expect(seen.find((m) => m.type === "hello")?.role).toBe("agent");
    expect(await sessions.mcpClose()).toMatchObject({ exitCode: 0, stdoutClean: true });
  });
});
