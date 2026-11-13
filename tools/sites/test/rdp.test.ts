import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rdp, encodePacket, longStringOrValue, parsePackets } from "../rdp.mjs";

describe("packet framing", () => {
  it("encodes the byte length, not the character length", () => {
    expect(encodePacket({ to: "root", t: "ä" }).toString("utf8")).toBe('22:{"to":"root","t":"ä"}');
  });

  it("parses joined packets and keeps a partial one for later", () => {
    const a = encodePacket({ from: "root", n: 1 });
    const b = encodePacket({ from: "x", n: "ä" });
    const joined = Buffer.concat([a, b]);
    const cut = joined.subarray(0, joined.length - 3);
    const first = parsePackets(cut);
    expect(first.packets).toEqual([{ from: "root", n: 1 }]);
    const second = parsePackets(Buffer.concat([first.rest, joined.subarray(joined.length - 3)]));
    expect(second.packets).toEqual([{ from: "x", n: "ä" }]);
    expect(second.rest.length).toBe(0);
  });

  it("rejects a header that is not a length", () => {
    expect(() => parsePackets(Buffer.from("bulk x y 3:abc"))).toThrow(/bad packet header/);
  });
});

describe("longStringOrValue", () => {
  it("maps grips for undefined, null and long strings", () => {
    expect(longStringOrValue("x")).toBe("x");
    expect(longStringOrValue(3)).toBe(3);
    expect(longStringOrValue({ type: "undefined" })).toBe(undefined);
    expect(longStringOrValue({ type: "null" })).toBe(null);
    expect(longStringOrValue({ type: "longString", initial: "abc", length: 9 })).toBe("abc");
  });
});

/** @type {Array<() => void>} */
const cleanups = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/**
 * A fake DevTools server on a Unix socket: greets, then answers with `handler`.
 * @param {(packet: any, send: (p: object) => void) => void} handler
 */
async function fakeServer(handler) {
  const dir = mkdtempSync(join(tmpdir(), "rdp-test-"));
  const path = join(dir, "s.sock");
  /** @type {import("node:net").Socket[]} */
  const sockets = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    const send = (/** @type {object} */ p) => socket.write(encodePacket(p));
    send({ from: "root", applicationType: "browser", traits: {} });
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const { packets, rest } = parsePackets(buf);
      buf = rest;
      for (const p of packets) handler(p, send);
    });
  });
  await new Promise((resolve) => server.listen(path, () => resolve(undefined)));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, sockets };
}

describe("Rdp", () => {
  it("matches replies to requests per actor, in order, and ignores events", async () => {
    // An actor answers its own requests in order (RDP); different actors interleave.
    /** @type {Map<string, Promise<void>>} */
    const chains = new Map();
    const { path } = await fakeServer((p, send) => {
      const delay = p.type === "slow" ? 30 : 0;
      const prev = chains.get(p.to) ?? Promise.resolve();
      const next = prev.then(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              send({ from: p.to, type: "tabListChanged" });
              send({ from: p.to, v: p.type });
              resolve(undefined);
            }, delay),
          ),
      );
      chains.set(p.to, next);
    });
    const rdp = await Rdp.connect(path);
    /** @type {string[]} */
    const order = [];
    const track = (/** @type {Promise<any>} */ p) => p.then((r) => (order.push(r.v), r));
    const [a, b, c] = await Promise.all([
      track(rdp.request("actorA", "slow")),
      track(rdp.request("actorB", "fast")),
      track(rdp.request("actorA", "second")),
    ]);
    expect([a.v, b.v, c.v]).toEqual(["slow", "fast", "second"]);
    expect(order).toEqual(["fast", "slow", "second"]);
    rdp.close();
  });

  it("rejects an error reply", async () => {
    const { path } = await fakeServer((p, send) =>
      send({ from: p.to, error: "noSuchActor", message: "gone" }),
    );
    const rdp = await Rdp.connect(path);
    await expect(rdp.request("x", "y")).rejects.toThrow("rdp: noSuchActor: gone");
    rdp.close();
  });

  it("evaluate waits for the evaluationResult with its resultID", async () => {
    const { path } = await fakeServer((p, send) => {
      expect(p).toMatchObject({ to: "console1", type: "evaluateJSAsync", text: "1+1" });
      send({ from: "console1", resultID: "r7" });
      send({ from: "console1", type: "evaluationResult", resultID: "r6", result: "other" });
      send({ from: "console1", type: "evaluationResult", resultID: "r7", result: 2 });
    });
    const rdp = await Rdp.connect(path);
    expect(await rdp.evaluate("console1", "1+1")).toBe(2);
    rdp.close();
  });

  it("evaluate fetches the whole of a long string result", async () => {
    const full = "x".repeat(1500);
    const { path } = await fakeServer((p, send) => {
      if (p.type === "evaluateJSAsync") {
        send({ from: p.to, resultID: "r1" });
        send({
          from: p.to,
          type: "evaluationResult",
          resultID: "r1",
          result: { type: "longString", actor: "ls1", initial: full.slice(0, 1000), length: 1500 },
        });
      } else if (p.to === "ls1" && p.type === "substring") {
        send({ from: "ls1", substring: full.slice(p.start, p.end) });
      }
    });
    const rdp = await Rdp.connect(path);
    expect(await rdp.evaluate("c", "big")).toBe(full);
    rdp.close();
  });

  it("evaluate throws the page's exception message", async () => {
    const { path } = await fakeServer((p, send) => {
      send({ from: p.to, resultID: "r1" });
      send({
        from: p.to,
        type: "evaluationResult",
        resultID: "r1",
        hasException: true,
        exceptionMessage: "ReferenceError: nope is not defined",
      });
    });
    const rdp = await Rdp.connect(path);
    await expect(rdp.evaluate("c", "nope")).rejects.toThrow(
      "rdp: evaluation threw: ReferenceError: nope is not defined",
    );
    rdp.close();
  });

  it("parentConsole and tabConsole walk descriptor → target", async () => {
    const { path } = await fakeServer((p, send) => {
      if (p.type === "getProcess") send({ from: "root", processDescriptor: { actor: "pd" } });
      else if (p.type === "getTab") {
        expect(p.browserId).toBe(12);
        send({ from: "root", tab: { actor: "td" } });
      } else if (p.to === "pd") send({ from: "pd", process: { consoleActor: "pc" } });
      else if (p.to === "td") send({ from: "td", frame: { consoleActor: "tc" } });
    });
    const rdp = await Rdp.connect(path);
    expect(await rdp.parentConsole()).toBe("pc");
    expect(await rdp.tabConsole(12)).toBe("tc");
    rdp.close();
  });

  it("a closed connection rejects what is pending and what comes next", async () => {
    const { path, sockets } = await fakeServer(() => {
      for (const s of sockets) s.destroy();
    });
    const rdp = await Rdp.connect(path);
    await expect(rdp.request("x", "y")).rejects.toThrow("rdp: connection closed");
    await expect(rdp.request("x", "z")).rejects.toThrow("rdp: connection closed");
  });
});
