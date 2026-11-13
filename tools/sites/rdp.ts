// A minimal client for Firefox's DevTools remote debugging protocol (RDP), the read-only observer
// of the site-compatibility suite (docs/specs/site-compat.md, decision 2). Keys, navigation and
// mode still go through vimma-ctl; this only evaluates read-only probes in the parent process and
// in a tab. Not WebDriver: WebDriver BiDi and Marionette set navigator.webdriver (engine
// dom/base/Navigator.cpp, Navigator::Webdriver), which bot checks look for; the DevTools server
// does not.
//
// Transport (engine devtools/shared/transport/transport.js): packets are `<byte length>:<JSON>`.
// A request is `{ to, type, ...args }`; each actor answers its requests in order with
// `{ from, ... }`. Events carry a `type` too; the one we use is the console actor's
// `evaluationResult`, which follows the `{ resultID }` reply to evaluateJSAsync.
import { connect } from "node:net";

/** Events we never mistake for a reply; everything else with a pending request is one. */
const EVENTS = new Set([
  "evaluationResult",
  "tabListChanged",
  "addonListChanged",
  "workerListChanged",
  "serviceWorkerRegistrationListChanged",
  "processListChanged",
  "frameUpdate",
  "tabNavigated",
  "tabDetached",
  "descriptor-destroyed",
  "target-destroyed-form",
  "resources-available-array",
  "resources-updated-array",
  "resources-destroyed-array",
  "newSource",
  "consoleAPICall",
  "pageError",
  "logMessage",
  "documentEvent",
  "networkEvent",
  "networkEventUpdate",
  "lastPrivateContextExited",
  "workerHelper",
]);

/**
 * Split a byte buffer into complete RDP packets.
 * @param {Buffer} buffer
 * @returns {{ packets: any[], rest: Buffer }}
 */
export function parsePackets(buffer) {
  /** @type {any[]} */
  const packets = [];
  let rest = buffer;
  for (;;) {
    const colon = rest.indexOf(0x3a); // ":"
    if (colon < 0) break;
    const head = rest.subarray(0, colon).toString("latin1");
    if (!/^\d+$/.test(head)) throw new Error(`rdp: bad packet header ${JSON.stringify(head)}`);
    const length = Number(head);
    if (rest.length < colon + 1 + length) break;
    packets.push(JSON.parse(rest.subarray(colon + 1, colon + 1 + length).toString("utf8")));
    rest = rest.subarray(colon + 1 + length);
  }
  return { packets, rest };
}

/** @param {object} packet @returns {Buffer} */
export function encodePacket(packet) {
  const body = Buffer.from(JSON.stringify(packet), "utf8");
  return Buffer.concat([Buffer.from(`${body.length}:`, "latin1"), body]);
}

export class Rdp {
  /** @param {import("node:net").Socket} socket */
  constructor(socket) {
    this.socket = socket;
    /** @type {Map<string, Array<{ resolve: (p: any) => void, reject: (e: Error) => void }>>} */
    this.pending = new Map();
    /** @type {Map<string, (p: any) => void>} evaluateJSAsync resultID → resolve */
    this.results = new Map();
    /**
     * Results that came before evaluate() saw their resultID: the reply and its event often
     * arrive in one chunk, and the reply's promise settles only after the chunk is dispatched.
     * @type {Map<string, any>}
     */
    this.early = new Map();
    /** @type {((p: any) => void) | null} */
    this.onGreeting = null;
    this.closed = false;
    /** @type {Buffer} */
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let parsed;
      try {
        parsed = parsePackets(buffer);
      } catch (e) {
        this.#fail(/** @type {Error} */ (e));
        return;
      }
      buffer = parsed.rest;
      for (const p of parsed.packets) this.#dispatch(p);
    });
    socket.on("close", () => this.#fail(new Error("rdp: connection closed")));
    socket.on("error", (e) => this.#fail(e));
  }

  /**
   * Connect to a server started with `--start-debugger-server <path>` (a Unix socket).
   * @param {string} path
   * @param {{ timeoutMs?: number }} [options]
   */
  static connect(path, { timeoutMs = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`rdp: no greeting from ${path} in ${timeoutMs} ms`));
      }, timeoutMs);
      const client = new Rdp(socket);
      client.onGreeting = () => {
        clearTimeout(timer);
        resolve(client);
      };
      socket.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /** @param {Error} e */
  #fail(e) {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.pending.values()) for (const p of queue) p.reject(e);
    this.pending.clear();
    this.results.clear();
  }

  /** @param {any} packet */
  #dispatch(packet) {
    if (this.onGreeting && packet.from === "root" && packet.applicationType) {
      const greet = this.onGreeting;
      this.onGreeting = null;
      greet(packet);
      return;
    }
    if (packet.type === "evaluationResult") {
      const resolve = this.results.get(packet.resultID);
      if (resolve) {
        this.results.delete(packet.resultID);
        resolve(packet);
      } else {
        this.early.set(packet.resultID, packet);
        // only the newest few matter: drop results nobody waits for
        const oldest = this.early.keys().next();
        if (this.early.size > 64 && !oldest.done) this.early.delete(oldest.value);
      }
      return;
    }
    if (packet.type && EVENTS.has(packet.type)) return;
    const queue = this.pending.get(packet.from);
    const waiter = queue?.shift();
    if (!waiter) return;
    if (packet.error) waiter.reject(new Error(`rdp: ${packet.error}: ${packet.message ?? ""}`));
    else waiter.resolve(packet);
  }

  /**
   * @param {string} to actor id
   * @param {string} type method
   * @param {object} [args]
   * @returns {Promise<any>}
   */
  request(to, type, args = {}) {
    if (this.closed) return Promise.reject(new Error("rdp: connection closed"));
    return new Promise((resolve, reject) => {
      const queue = this.pending.get(to) ?? [];
      queue.push({ resolve, reject });
      this.pending.set(to, queue);
      this.socket.write(encodePacket({ to, type, ...args }));
    });
  }

  /** The parent process's console actor (chrome scope; needs devtools.chrome.enabled). */
  async parentConsole() {
    const { processDescriptor } = await this.request("root", "getProcess", { id: 0 });
    const { process } = await this.request(processDescriptor.actor, "getTarget");
    return /** @type {string} */ (process.consoleActor);
  }

  /**
   * A tab's console actor, by the browserId vimma-ctl's state reports as the tab id.
   * @param {number} browserId
   */
  async tabConsole(browserId) {
    const { tab } = await this.request("root", "getTab", { browserId });
    const { frame } = await this.request(tab.actor, "getTarget");
    return /** @type {string} */ (frame.consoleActor);
  }

  /**
   * Evaluate `text` with a console actor and return its value. Probes return JSON strings, so
   * only primitives come back; anything else is a grip, returned as is.
   * @param {string} consoleActor
   * @param {string} text
   * @param {{ timeoutMs?: number }} [options]
   */
  async evaluate(consoleActor, text, { timeoutMs = 10_000 } = {}) {
    const { resultID } = await this.request(consoleActor, "evaluateJSAsync", {
      text,
      eager: false,
      disableBreaks: true,
    });
    const packet = await new Promise((resolve, reject) => {
      const early = this.early.get(resultID);
      if (early) {
        this.early.delete(resultID);
        resolve(early);
        return;
      }
      const timer = setTimeout(() => {
        this.results.delete(resultID);
        reject(new Error(`rdp: no evaluation result in ${timeoutMs} ms`));
      }, timeoutMs);
      this.results.set(resultID, (/** @type {any} */ p) => {
        clearTimeout(timer);
        resolve(p);
      });
    });
    if (packet.hasException || packet.exceptionMessage) {
      throw new Error(`rdp: evaluation threw: ${packet.exceptionMessage ?? "an exception"}`);
    }
    const result = packet.result;
    // Strings over the server's limit come as a long-string actor with only the start inline.
    if (result?.type === "longString" && result.actor) {
      const { substring } = await this.request(result.actor, "substring", {
        start: 0,
        end: result.length,
      });
      return substring;
    }
    return longStringOrValue(result);
  }

  close() {
    this.closed = true;
    this.socket.destroy();
  }
}

/**
 * A primitive result as is; the `undefined`/`null` grips as JS values; a long string's initial
 * part (probes keep their JSON short, so this only guards).
 * @param {any} result
 */
export function longStringOrValue(result) {
  if (result === null || typeof result !== "object") return result;
  if (result.type === "undefined") return undefined;
  if (result.type === "null") return null;
  if (result.type === "longString") return result.initial;
  return result;
}
