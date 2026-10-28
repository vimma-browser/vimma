import { describe, test, expect } from "vitest";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONTROL_PROTOCOL,
  CONTROL_COMMANDS,
  RESERVED_COMMANDS,
  ERROR_CODES,
  MAX_LINE_LENGTH,
  validateMessage,
  tokensEqual,
  LineFramer,
} from "../src/control.mjs";

const FIXTURES = fileURLToPath(new URL("../../../tests/contract/control/v1/", import.meta.url));
const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
/** @param {string} name */
const fixture = (name) => JSON.parse(readFileSync(FIXTURES + name, "utf8"));

const TOKEN = "0123456789abcdef".repeat(4);
const NONCE = "fedcba9876543210".repeat(4);
const hello = (extra = {}) => ({ type: "hello", protocol: 1, nonce: NONCE, ...extra });
const req = (command, args = {}, id = 1) => ({ type: "request", id, command, args });
const ok = (result, id = 1) => ({ type: "response", id, ok: true, result });
const errorsOf = (message, options) => validateMessage(message, options).errors;

describe("contract fixtures (tests/contract/control/v1)", () => {
  test("every message type has one valid and one invalid fixture", () => {
    const types = new Set(files.map((f) => f.replace(/\.(valid|invalid)\.json$/, "")));
    expect(types.size).toBeGreaterThanOrEqual(11);
    for (const type of types) {
      expect(files).toContain(`${type}.valid.json`);
      expect(files).toContain(`${type}.invalid.json`);
    }
    expect(files.length).toBe(types.size * 2);
  });

  test("challenge.valid's proof is HMAC-SHA256(token, vimma-server NUL nonce)", () => {
    const { nonce } = fixture("hello.valid.json").message;
    const { token } = fixture("auth.valid.json").message;
    const { proof } = fixture("challenge.valid.json").message;
    const mac = (text) => createHmac("sha256", token).update(text).digest("hex");
    expect(mac(`vimma-server\0${nonce}`)).toBe(proof);
    expect(mac(nonce)).not.toBe(proof); // domain-separated
  });

  test.each(files)("%s validates as its name says", (name) => {
    const { kind, command, message } = fixture(name);
    const result = validateMessage(message, { kind, command });
    if (name.endsWith(".valid.json")) {
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    } else {
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("constants", () => {
  test("protocol version 1 with the commands of ADR-007", () => {
    expect(CONTROL_PROTOCOL).toBe(1);
    expect([...CONTROL_COMMANDS]).toEqual(["send-keys", "state", "open", "reload-theme"]);
    expect([...RESERVED_COMMANDS]).toEqual(["list-tabs", "screenshot", "reload-config"]);
    expect(ERROR_CODES).toContain("not-implemented");
    expect(ERROR_CODES).toContain("busy");
    expect(MAX_LINE_LENGTH).toBe(1024 * 1024);
  });
});

describe("validateMessage: envelopes", () => {
  test.each([
    ["a string", "hello"],
    ["null", null],
    ["an array", []],
  ])("rejects %s", (_, value) => {
    expect(errorsOf(value)).toEqual(["message must be a JSON object"]);
  });

  test("infers the kind from type and rejects an unknown type", () => {
    expect(validateMessage(hello()).valid).toBe(true);
    expect(errorsOf({ type: "goodbye" })).toEqual(['unknown message type "goodbye"']);
  });

  // Regression (found by the fuzzer, seed 31429): the error message stringified `type`, which
  // throws for an object whose toString is not a function, as JSON.parse can make.
  test("a type that is not a string is an error, never a throw", () => {
    for (const text of ['{"type":{"toString":0}}', '{"type":{"valueOf":{}}}', '{"type":[]}']) {
      expect(validateMessage(JSON.parse(text)).valid, text).toBe(false);
    }
    expect(errorsOf({ type: 7 })).toEqual(["unknown message type 7"]);
  });

  test("a kind that disagrees with type is an error", () => {
    expect(errorsOf(req("state"), { kind: "response" })).toContain('type must be "response"');
  });

  test("hello: protocol a positive integer and a 64-hex nonce; never the token", () => {
    expect(errorsOf(hello({ protocol: 0 }))).toEqual(["protocol must be an integer >= 1"]);
    expect(errorsOf(hello({ extra: 1 }))).toEqual(['unknown field "extra"']);
    expect(errorsOf(hello({ token: TOKEN }))).toEqual(['unknown field "token"']);
    expect(errorsOf(hello({ nonce: undefined }))).toEqual([
      "nonce must be 64 lowercase hex characters",
    ]);
    expect(errorsOf(hello({ nonce: NONCE.toUpperCase() }))).toEqual([
      "nonce must be 64 lowercase hex characters",
    ]);
  });

  test("challenge: a 64-hex proof; extra fields allowed", () => {
    const proof = "ab".repeat(32);
    expect(errorsOf({ type: "challenge", protocol: 1, proof, more: 1 })).toEqual([]);
    expect(errorsOf({ type: "challenge", protocol: 1 })).toEqual([
      "proof must be 64 lowercase hex characters",
    ]);
    expect(errorsOf({ type: "challenge", protocol: 1.5, proof })).toEqual([
      "protocol must be an integer >= 1",
    ]);
  });

  test("auth: exactly a 64-hex token", () => {
    expect(errorsOf({ type: "auth", token: TOKEN })).toEqual([]);
    expect(errorsOf({ type: "auth", token: TOKEN.toUpperCase() })).toEqual([
      "token must be 64 lowercase hex characters",
    ]);
    expect(errorsOf({ type: "auth", token: TOKEN, nonce: NONCE })).toEqual([
      'unknown field "nonce"',
    ]);
  });

  test("request ids are integers in 1..2^53-1", () => {
    for (const id of [0, -1, 1.5, "1", null, 2 ** 53]) {
      expect(errorsOf(req("state", {}, /** @type {any} */ (id)))).toEqual([
        "id must be an integer from 1 to 2^53-1",
      ]);
    }
    expect(errorsOf(req("state", {}, 2 ** 53 - 1))).toEqual([]);
  });

  test("request args must be an object", () => {
    expect(errorsOf({ type: "request", id: 1, command: "state" })).toEqual([
      "args must be an object",
    ]);
  });

  test("reserved commands are valid requests with any args", () => {
    for (const command of RESERVED_COMMANDS) {
      expect(errorsOf(req(command, { anything: 1 }))).toEqual([]);
    }
  });

  test("responses need ok and exactly one of result and error", () => {
    expect(errorsOf({ type: "response", id: 1, ok: true })).toEqual([
      "ok: true needs result and no error",
    ]);
    expect(errorsOf({ type: "response", id: 1, ok: false, result: {} })).toEqual([
      "ok: false needs error and no result",
    ]);
    expect(errorsOf({ type: "response", id: 1, ok: "yes", result: {} })).toContain(
      "ok must be a boolean",
    );
  });

  test("response id may be null (handshake errors) but not missing", () => {
    const error = { code: "unauthorized", message: "bad token" };
    expect(errorsOf({ type: "response", id: null, ok: false, error })).toEqual([]);
    expect(errorsOf({ type: "response", ok: false, error })).toEqual([
      "id must be an integer from 1 to 2^53-1 or null",
    ]);
  });

  test.each(ERROR_CODES)("error code %s is accepted", (code) => {
    // A protocol 2 denial also says why (control-v2.test.mjs).
    const error = { code, message: "m", ...(code === "denied" ? { reason: "user" } : {}) };
    expect(errorsOf({ type: "response", id: 1, ok: false, error })).toEqual([]);
  });

  test("error must be an object without extra fields", () => {
    expect(errorsOf({ type: "response", id: 1, ok: false, error: "boom" })).toEqual([
      "error must be an object",
    ]);
    const error = { code: "failed", message: "m", stack: "x" };
    expect(errorsOf({ type: "response", id: 1, ok: false, error })).toEqual([
      'unknown field "error.stack"',
    ]);
  });

  test("error needs a string message", () => {
    expect(
      errorsOf({ type: "response", id: 1, ok: false, error: { code: "failed", message: 3 } }),
    ).toEqual(["error.message must be a string"]);
  });

  test("welcome needs app and version strings and allows extra fields", () => {
    expect(errorsOf({ type: "welcome", protocol: 1, app: "Vimma" })).toEqual([
      "version must be a string",
    ]);
    expect(errorsOf({ type: "welcome", protocol: 1, app: "Vimma", version: "1" })).toEqual([]);
  });
});

describe("validateMessage: send-keys", () => {
  test.each(["ctrl+b c", "g t", "esc", "shift+t", "  ctrl+b\tc  "])("accepts %j", (keys) => {
    expect(errorsOf(req("send-keys", { keys }))).toEqual([]);
  });

  test.each([
    ["", "keys must contain 1 to 256 chords"],
    ["   ", "keys must contain 1 to 256 chords"],
    [Array(257).fill("j").join(" "), "keys must contain 1 to 256 chords"],
    ["prefix+c", 'keys: "prefix+c" is not a chord'],
    ["<leader>", 'keys: "<leader>" is not a chord'],
  ])("rejects %j", (keys, message) => {
    expect(errorsOf(req("send-keys", { keys }))).toEqual([message]);
  });

  test("keys must be a string and nothing else is allowed", () => {
    expect(errorsOf(req("send-keys", { keys: 1 }))).toEqual(["keys must be a string"]);
    expect(errorsOf(req("send-keys", { keys: "j", count: 2 }))).toEqual([
      'unknown field "args.count"',
    ]);
  });

  test("result is a non-negative integer count", () => {
    expect(errorsOf(ok({ sent: 0 }), { command: "send-keys" })).toEqual([]);
    expect(errorsOf(ok({ sent: -1 }), { command: "send-keys" })).toEqual([
      "result.sent must be an integer >= 0",
    ]);
  });
});

describe("validateMessage: open", () => {
  test.each([
    "https://example.com/",
    "http://localhost:8080/x?y#z",
    "file:///tmp/a.html",
    "about:blank",
  ])("accepts %s", (url) => {
    expect(errorsOf(req("open", { url }))).toEqual([]);
  });

  test.each([
    ["javascript:alert(1)", "url scheme must be http, https, file or about"],
    ["JavaScript:alert(1)", "url scheme must be http, https, file or about"],
    ["data:text/html,hi", "url scheme must be http, https, file or about"],
    ["example.com", "url must be an absolute URL"],
    ["", "url must be an absolute URL"],
    ["https://a/\n", "url must not contain control characters or spaces"],
    ["https://" + "a".repeat(65536), "url must be at most 65536 characters"],
  ])("rejects %j", (url, message) => {
    expect(errorsOf(req("open", { url }))).toEqual([message]);
  });

  test("where is tab or current", () => {
    expect(errorsOf(req("open", { url: "about:blank", where: "current" }))).toEqual([]);
    expect(errorsOf(req("open", { url: "about:blank", where: "window" }))).toEqual([
      'where must be "tab" or "current"',
    ]);
  });

  test("result is a tab id string", () => {
    expect(errorsOf(ok({ tab: "1" }), { command: "open" })).toEqual([]);
    expect(errorsOf(ok({}), { command: "open" })).toEqual(["result.tab must be a string"]);
  });
});

describe("validateMessage: reload-theme", () => {
  test("takes no args", () => {
    expect(errorsOf(req("reload-theme"))).toEqual([]);
    expect(errorsOf(req("reload-theme", { path: "/tmp/colors.toml" }))).toEqual([
      'unknown field "args.path"',
    ]);
  });

  test("result says whether the colours changed", () => {
    expect(errorsOf(ok({ changed: false }), { command: "reload-theme" })).toEqual([]);
    expect(errorsOf(ok({ changed: true, extra: 1 }), { command: "reload-theme" })).toEqual([]);
    expect(errorsOf(ok({}), { command: "reload-theme" })).toEqual([
      "result.changed must be a boolean",
    ]);
  });
});

describe("validateMessage: state", () => {
  const state = {
    mode: "normal",
    pending: null,
    workspace: null,
    tabs: [{ id: "1", url: "about:blank", title: "", selected: true }],
    panes: null,
  };

  test("accepts M0 state and ignores unknown fields", () => {
    expect(errorsOf(ok(state), { command: "state" })).toEqual([]);
    expect(errorsOf(ok({ ...state, future: [1] }), { command: "state" })).toEqual([]);
    expect(errorsOf(ok({ ...state, workspace: "work", panes: {} }), { command: "state" })).toEqual(
      [],
    );
  });

  test("reports each broken field", () => {
    const broken = {
      mode: 1,
      pending: 2,
      workspace: 3,
      tabs: [{ id: 1, url: null, title: null, selected: "yes" }, "x"],
    };
    expect(errorsOf(ok(broken), { command: "state" })).toEqual([
      "result.mode must be one of normal, insert, visual, command, hint, element, help, panel, resize",
      "result.pending must be a string or null",
      "result.workspace must be a string or null",
      "result.tabs[0].id must be a string",
      "result.tabs[0].url must be a string",
      "result.tabs[0].title must be a string",
      "result.tabs[0].selected must be a boolean",
      "result.tabs[1] must be an object",
      "result.panes must be present (null before split view)",
    ]);
  });

  test("a private window's state withholds every url and title (private-workspace 8d)", () => {
    const hidden = { id: "1", url: null, title: null, selected: true };
    const priv = { ...state, private: true, workspace: "private", tabs: [hidden] };
    expect(errorsOf(ok(priv), { command: "state" })).toEqual([]);
    const leaked = { ...priv, tabs: [{ ...hidden, url: "https://a.example/", title: "A" }] };
    expect(errorsOf(ok(leaked), { command: "state" })).toEqual([
      "result.tabs[0].url must be null in a private window",
      "result.tabs[0].title must be null in a private window",
    ]);
    expect(errorsOf(ok({ ...state, private: "yes" }), { command: "state" })).toEqual([
      "result.private must be a boolean",
    ]);
    expect(errorsOf(ok({ ...state, private: false }), { command: "state" })).toEqual([]);
  });

  test("tabs must be an array with at most one selected tab", () => {
    expect(errorsOf(ok({ ...state, tabs: {} }), { command: "state" })).toEqual([
      "result.tabs must be an array",
    ]);
    const two = { ...state, tabs: [state.tabs[0], state.tabs[0]] };
    expect(errorsOf(ok(two), { command: "state" })).toEqual([
      "result.tabs must have at most one selected tab",
    ]);
  });

  test("result shapes are checked only when the command is known", () => {
    expect(errorsOf(ok({ anything: true }))).toEqual([]);
    expect(errorsOf(ok("not an object"), { command: "state" })).toEqual([
      "result must be an object",
    ]);
  });
});

describe("validateMessage: discovery file", () => {
  const file = { protocol: 1, port: 43817, token: TOKEN, pid: 1 };

  test("accepts the spec's file", () => {
    expect(errorsOf(file, { kind: "discovery" })).toEqual([]);
  });

  test.each([
    [{ ...file, port: 0 }, "port must be an integer from 1 to 65535"],
    [{ ...file, pid: 0 }, "pid must be an integer >= 1"],
    [{ ...file, token: "" }, "token must be 64 lowercase hex characters"],
    [{ ...file, protocol: undefined }, "protocol must be an integer >= 1"],
  ])("rejects %j", (value, message) => {
    expect(errorsOf(value, { kind: "discovery" })).toEqual([message]);
  });

  test("unknown kind option is an error", () => {
    expect(errorsOf(file, { kind: /** @type {any} */ ("nope") })).toEqual([
      'unknown message kind "nope"',
    ]);
  });
});

describe("tokensEqual", () => {
  test("equal tokens", () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true);
  });

  test.each([
    [TOKEN, TOKEN.slice(0, 63) + "0"],
    [TOKEN, "1" + TOKEN.slice(1)],
    [TOKEN, TOKEN.slice(0, 63)],
    [TOKEN, ""],
    ["", ""],
  ])("unequal or empty tokens: %#", (a, b) => {
    expect(tokensEqual(a, b)).toBe(false);
  });

  test("non-strings are never equal", () => {
    expect(tokensEqual(/** @type {any} */ (undefined), /** @type {any} */ (undefined))).toBe(false);
    expect(tokensEqual(TOKEN, /** @type {any} */ (null))).toBe(false);
  });
});

describe("LineFramer (the server's framing)", () => {
  const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s);
  const text = (/** @type {Uint8Array[]} */ lines) => lines.map((l) => new TextDecoder().decode(l));

  test("splits on \\n, drops one \\r before it, and keeps a partial line for the next push", () => {
    const f = new LineFramer(16);
    expect(text(f.push(bytes('{"a":1}\n{"b"')))).toEqual(['{"a":1}']);
    expect(text(f.push(bytes(":2}\r\n\r\n\n")))).toEqual(['{"b":2}', "", ""]);
    expect(text(f.push(bytes("x\r\r\n")))).toEqual(["x\r"]);
    expect(f.overflow).toBe(false);
  });

  test("a line of max bytes passes, with or without \\r; one byte more overflows", () => {
    expect(text(new LineFramer(4).push(bytes("abcd\nabcd\r\n")))).toEqual(["abcd", "abcd"]);
    const f = new LineFramer(4);
    expect(text(f.push(bytes("ab\nabcde\nok\n")))).toEqual(["ab"]);
    expect(f.overflow).toBe(true);
    expect(f.push(bytes("ok\n"))).toEqual([]);
  });

  test("an endless line overflows before its newline, holding at most max + 1 bytes", () => {
    const f = new LineFramer(4);
    expect(f.push(bytes("abcd"))).toEqual([]);
    expect(f.push(bytes("\r"))).toEqual([]);
    expect(f.overflow).toBe(false);
    expect(f.push(bytes("x"))).toEqual([]);
    expect(f.overflow).toBe(true);
  });

  test("the default limit is MAX_LINE_LENGTH", () => {
    expect(new LineFramer().max).toBe(MAX_LINE_LENGTH);
  });
});
