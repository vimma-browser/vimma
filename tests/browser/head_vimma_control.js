/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// A control-protocol client for the vimma-mcp mochitests (docs/specs/vimma-mcp.md): the
// handshake (hello, the server's HMAC proof, auth) and JSON-line requests over
// nsISocketTransport. Loaded with Services.scriptloader.loadSubScript into the test's scope.

"use strict";

/* exported Client, discovery, hmacHex, tidyTask */

const CONTROL_DISCOVERY = PathUtils.join(PathUtils.profileDir, "vimma-control.json");

/**
 * `task` under its own name, then `after` however it ended: a task that fails part-way leaves
 * no agent tab, connection, grant or workspace behind, which the next task would trip over.
 * @param {() => Promise<void>} task @param {() => Promise<void>} after
 */
function tidyTask(task, after) {
  return {
    async [task.name]() {
      try {
        await task();
      } finally {
        await after();
      }
    },
  }[task.name];
}

/** The discovery file's contents: port, token, protocol and roles. */
async function discovery() {
  return JSON.parse(await IOUtils.readUTF8(CONTROL_DISCOVERY));
}

/** HMAC-SHA256 hex, as the server's challenge. @param {string} key @param {string} text */
async function hmacHex(key, text) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A protocol client over nsISocketTransport: JSON lines both ways. */
class Client {
  /** @param {number} port */
  constructor(port) {
    const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(
      Ci.nsISocketTransportService,
    );
    this.transport = sts.createTransport([], "127.0.0.1", port, null, null);
    this.output = this.transport.openOutputStream(0, 0, 0);
    this.input = this.transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
    this.binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    this.binary.setInputStream(this.input);
    this.buffer = "";
    /** @type {any[]} */
    this.messages = [];
    /** @type {Array<() => void>} */
    this.waiters = [];
    this.closed = false;
    this.wait();
  }

  wait() {
    this.input.asyncWait(this, 0, 0, Services.tm.mainThread);
  }

  onInputStreamReady() {
    try {
      const n = Math.max(this.input.available(), 1);
      const chunk = new Uint8Array(n);
      const read = this.binary.readArrayBuffer(n, chunk.buffer);
      if (read === 0) return this.end();
      // In pieces: spreading a large chunk into fromCharCode overflows the stack.
      for (let i = 0; i < read; i += 8192) {
        this.buffer += String.fromCharCode(...chunk.subarray(i, Math.min(i + 8192, read)));
      }
      let nl;
      while ((nl = this.buffer.indexOf("\n")) !== -1) {
        const bytes = Uint8Array.from(this.buffer.slice(0, nl), (c) => c.charCodeAt(0));
        const message = JSON.parse(new TextDecoder().decode(bytes));
        // The line's size in bytes, for the 1 MiB limit (not enumerable: deepEqual ignores it).
        Object.defineProperty(message, "bytes", { value: bytes.length });
        this.messages.push(message);
        this.buffer = this.buffer.slice(nl + 1);
      }
      this.wake();
      this.wait();
    } catch (e) {
      if (/** @type {any} */ (e).result === Cr.NS_BASE_STREAM_WOULD_BLOCK) this.wait();
      else this.end();
    }
    return undefined;
  }

  end() {
    this.closed = true;
    this.wake();
  }

  wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** The next message matching `pred`, or null once closed. @param {(m: any) => boolean} pred */
  async take(pred = () => true) {
    for (;;) {
      const i = this.messages.findIndex(pred);
      if (i !== -1) return this.messages.splice(i, 1)[0];
      if (this.closed) return null;
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }

  /** @param {object} message */
  send(message) {
    this.sendLines([message]);
  }

  /** Several messages in one write, so the server reads them together. @param {object[]} ms */
  sendLines(ms) {
    const bytes = new TextEncoder().encode(ms.map((m) => JSON.stringify(m) + "\n").join(""));
    let data = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      data += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    this.output.write(data, data.length);
  }

  /**
   * The handshake with `hello` (protocol and role); resolves to the welcome or the error.
   * @param {{ protocol: number, role?: string }} hello
   */
  async handshake(hello, auth = {}) {
    const { token } = await discovery();
    const nonce = "ab".repeat(32);
    this.send({ type: "hello", nonce, ...hello });
    const challenge = await this.take();
    if (challenge?.type !== "challenge") return challenge;
    Assert.equal(challenge.protocol, hello.protocol, "the challenge speaks the hello's protocol");
    Assert.equal(
      challenge.proof,
      await hmacHex(token, `vimma-server\0${nonce}`),
      "the server proves the token",
    );
    this.send({ type: "auth", token, ...auth });
    return this.take();
  }

  /** @param {string} command @param {object} [args] @param {number} [id] */
  request(command, args = {}, id = (this.nextId = (this.nextId ?? 0) + 1)) {
    this.send({ type: "request", id, command, args });
    return id;
  }

  /** @param {number} id */
  response(id) {
    return this.take((m) => m.type === "response" && m.id === id);
  }

  /** Send and wait for the answer. @param {string} command @param {object} [args] */
  call(command, args = {}) {
    return this.response(this.request(command, args));
  }

  close() {
    this.transport.close(Cr.NS_OK);
  }
}
