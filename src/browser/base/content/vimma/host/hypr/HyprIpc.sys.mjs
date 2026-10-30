/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hyprland's IPC sockets (docs/specs/private-swap.md decision 2, ADR-017), from the parent
// process only: no hyprctl, no exec. `.socket.sock` takes one request per connection and
// replies; `.socket2.sock` streams events as lines. Every request is checked against core's
// whitelist before it is sent (decision 4); content processes and pages never reach this.

import { hyprSockets, isAllowedRequest } from "../../core/hyprswap.mjs";

const lazy = /** @type {any} */ ({});
ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** No reply within this long is no Hyprland (decision 3). */
export const REPLY_MS = 500;
/** The most one step of that wait counts, however late its timer fires. */
const TICK_MS = 50;
/** A reply larger than this is cut off: j/clients with hundreds of windows is far below it. */
const MAX_REPLY = 4 * 1024 * 1024;

/** @type {{ request: string, events: string } | null | undefined} undefined: from the env */
let override;

/** @param {string} path */
function fileOf(path) {
  const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  f.initWithPath(path);
  return f;
}

/** @param {any} transport */
function streams(transport) {
  // Unbuffered: a buffered stream is a pipe that the socket thread copies later, so a close
  // could overtake what was written.
  const flags = Ci.nsITransport.OPEN_UNBUFFERED;
  const input = transport.openInputStream(flags, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
  const output = transport.openOutputStream(flags, 0, 0).QueryInterface(Ci.nsIAsyncOutputStream);
  const binary = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
  binary.setInputStream(input);
  return { input, output, binary };
}

/** @param {string} path */
function connect(path) {
  const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(
    Ci.nsISocketTransportService,
  );
  return /** @type {any} */ (sts).createUnixDomainTransport(fileOf(path));
}

/**
 * Writes all of `bytes` to an async output stream once it can take them.
 * @param {any} output
 * @param {Uint8Array} bytes
 * @returns {Promise<void>}
 */
function writeAll(output, bytes) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    const step = () => {
      try {
        while (offset < bytes.length) {
          const chunk = String.fromCharCode(...bytes.subarray(offset, offset + 4096));
          const n = output.write(chunk, chunk.length);
          offset += n;
          if (n < chunk.length) break;
        }
      } catch (e) {
        if (/** @type {any} */ (e)?.result !== Cr.NS_BASE_STREAM_WOULD_BLOCK) {
          reject(e);
          return;
        }
      }
      if (offset >= bytes.length) resolve();
      else output.asyncWait({ onOutputStreamReady: step }, 0, 0, Services.tm.mainThread);
    };
    output.asyncWait({ onOutputStreamReady: step }, 0, 0, Services.tm.mainThread);
  });
}

/**
 * Reads what is available: bytes, [] when nothing is there yet, null at the end of the stream.
 * A socket at its end reports 0 available until a read finds nothing, so 0 tries a read.
 * @param {any} input @param {any} binary
 * @returns {Uint8Array | null}
 */
function readAvailable(input, binary) {
  try {
    const n = input.available();
    return new Uint8Array(binary.readByteArray(n || 1));
  } catch (e) {
    if (/** @type {any} */ (e)?.result === Cr.NS_BASE_STREAM_WOULD_BLOCK) return new Uint8Array();
    return null; // closed, reset or at its end
  }
}

export const HyprIpc = {
  /**
   * The instance's two sockets, or null when the environment names none (decision 3), or when
   * their folder is writable by others: then they may not be the user's Hyprland.
   */
  get sockets() {
    const found =
      override !== undefined
        ? override
        : hyprSockets({
            signature: Services.env.get("HYPRLAND_INSTANCE_SIGNATURE") || undefined,
            runtimeDir: Services.env.get("XDG_RUNTIME_DIR") || undefined,
          });
    if (!found) return null;
    try {
      const dir = fileOf(found.request).parent;
      if (dir && dir.exists() && dir.permissions & 0o022) return null;
    } catch {
      // unreadable: connecting will fail and say so
    }
    return found;
  },

  /**
   * One request: connect, write, read until Hyprland closes. Rejects on a refused request (not
   * in the whitelist), no socket, or no reply within REPLY_MS.
   * @param {string} text
   * @returns {Promise<string>}
   */
  request(text) {
    if (!isAllowedRequest(text)) return Promise.reject(new Error("request not allowed"));
    const sockets = this.sockets;
    if (!sockets) return Promise.reject(new Error("no Hyprland socket"));
    return new Promise((resolve, reject) => {
      /** @type {any} */
      let transport;
      try {
        transport = connect(sockets.request);
      } catch (e) {
        reject(e);
        return;
      }
      const { input, output, binary } = streams(transport);
      /** @type {Uint8Array[]} */
      const chunks = [];
      let size = 0;
      let done = false;
      /** @type {unknown} */
      let timer = null;
      /** @param {Error | null} error */
      const finish = (error) => {
        if (done) return;
        done = true;
        lazy.clearTimeout(timer);
        try {
          transport.close(Cr.NS_OK);
        } catch {
          // already closed
        }
        if (error) {
          reject(error);
          return;
        }
        const all = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          all.set(c, at);
          at += c.length;
        }
        resolve(new TextDecoder().decode(all));
      };
      // Late only when Hyprland is: REPLY_MS counts in ticks of at most TICK_MS each, so a main
      // thread held by a window opening, with the reply's socket events queued behind it, does
      // not use up the wait. At most REPLY_MS / TICK_MS ticks in all.
      let waited = 0;
      let last = Date.now();
      const tick = () => {
        const now = Date.now();
        waited += Math.min(now - last, TICK_MS);
        last = now;
        if (waited >= REPLY_MS) finish(new Error("no reply"));
        else timer = lazy.setTimeout(tick, TICK_MS);
      };
      timer = lazy.setTimeout(tick, TICK_MS);
      const onReady = () => {
        if (done) return;
        const bytes = readAvailable(input, binary);
        if (!bytes) {
          // Closed with nothing said: refused or reset, not slow, so a retry would not help.
          finish(size ? null : new Error("refused"));
          return;
        }
        if (bytes.length) {
          chunks.push(bytes);
          size += bytes.length;
        }
        if (size > MAX_REPLY) {
          finish(new Error("reply too large"));
          return;
        }
        input.asyncWait({ onInputStreamReady: onReady }, 0, 0, Services.tm.mainThread);
      };
      writeAll(output, new TextEncoder().encode(text)).then(
        () => input.asyncWait({ onInputStreamReady: onReady }, 0, 0, Services.tm.mainThread),
        (e) => finish(e),
      );
    });
  },

  /**
   * Holds `.socket2.sock` open and hands each line to `onLine`; `onClose` when it ends. The
   * lines carry every window's title: the listener compares and drops them (decision 8).
   * @param {(line: string) => void} onLine
   * @param {() => void} onClose
   * @returns {{ close: () => void }}
   */
  listen(onLine, onClose) {
    const sockets = this.sockets;
    if (!sockets) throw new Error("no Hyprland socket");
    const transport = connect(sockets.events);
    const { input, binary } = streams(transport);
    let closed = false;
    let pending = "";
    const decoder = new TextDecoder();
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        transport.close(Cr.NS_OK);
      } catch {
        // already closed
      }
      onClose();
    };
    const onReady = () => {
      if (closed) return;
      const bytes = readAvailable(input, binary);
      if (!bytes) {
        close();
        return;
      }
      pending += decoder.decode(bytes, { stream: true });
      const lines = pending.split("\n");
      pending = /** @type {string} */ (lines.pop());
      // A runaway line without a newline is dropped rather than kept growing.
      if (pending.length > 65536) pending = "";
      for (const line of lines) {
        try {
          onLine(line);
        } catch (e) {
          console.error("vimma: hyprland event handler failed", e);
        }
      }
      input.asyncWait({ onInputStreamReady: onReady }, 0, 0, Services.tm.mainThread);
    };
    input.asyncWait({ onInputStreamReady: onReady }, 0, 0, Services.tm.mainThread);
    return { close };
  },

  /**
   * Tests only: talk to a fake Hyprland at these sockets (null: none at all; undefined: back to
   * the environment). The environment itself is never changed.
   * @param {{ request: string, events: string } | null | undefined} sockets
   */
  _setSocketsForTests(sockets) {
    override = sockets;
  },
};
