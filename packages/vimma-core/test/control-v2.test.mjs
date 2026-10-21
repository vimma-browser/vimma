// Control protocol 2 (docs/specs/vimma-mcp.md, decisions 2 and 4): the hello's role, the agent
// commands, `role-off` and `denied`. Fixtures in tests/contract/control/v2/; v1's are unchanged.
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENT_COMMANDS,
  CONTROL_COMMANDS,
  DENY_REASONS,
  ERROR_CODES,
  LATEST_PROTOCOL,
  PROTOCOLS,
  ROLES,
  validateMessage,
} from "../src/control.mjs";

const FIXTURES = fileURLToPath(new URL("../../../tests/contract/control/v2/", import.meta.url));
const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));
/** @param {string} name */
const fixture = (name) => JSON.parse(readFileSync(FIXTURES + name, "utf8"));

const NONCE = "fedcba9876543210".repeat(4);
const TOKEN = "0123456789abcdef".repeat(4);
const hello = (extra = {}) => ({
  type: "hello",
  protocol: 2,
  nonce: NONCE,
  role: "agent",
  ...extra,
});
const req = (command, args = {}, id = 1) => ({ type: "request", id, command, args });
const ok = (result, id = 1) => ({ type: "response", id, ok: true, result });
const errorsOf = (message, options) => validateMessage(message, options).errors;

describe("contract fixtures (tests/contract/control/v2)", () => {
  test("every new message has one valid and one invalid fixture", () => {
    const types = new Set(files.map((f) => f.replace(/\.(valid|invalid)\.json$/, "")));
    expect(types.size).toBeGreaterThanOrEqual(18);
    for (const type of types) {
      expect(files).toContain(`${type}.valid.json`);
      expect(files).toContain(`${type}.invalid.json`);
    }
    expect(files.length).toBe(types.size * 2);
    for (const command of AGENT_COMMANDS) {
      expect(files).toContain(`request-${command}.valid.json`);
      expect(files).toContain(`response-${command}.valid.json`);
    }
  });

  test.each(files)("%s validates as its name says", (name) => {
    const { kind, command, message } = fixture(name);
    const result = validateMessage(message, { kind, command });
    if (name.endsWith(".valid.json")) {
      expect(result.errors).toEqual([]);
    } else {
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});

describe("protocol 2 constants", () => {
  test("protocols 1 and 2, two roles, the agent commands apart from v1's", () => {
    expect(LATEST_PROTOCOL).toBe(2);
    expect([...PROTOCOLS]).toEqual([1, 2]);
    expect([...ROLES]).toEqual(["agent", "full"]);
    expect([...AGENT_COMMANDS]).toEqual([
      "agent-hello",
      "agent-tabs",
      "agent-read",
      "agent-open",
      "agent-close",
      "agent-ping",
      "agent-cancel",
      "agent-keys",
    ]);
    expect(AGENT_COMMANDS.some((c) => CONTROL_COMMANDS.includes(c))).toBe(false);
    expect(ERROR_CODES).toContain("role-off");
    expect(ERROR_CODES).toContain("denied");
    expect([...DENY_REASONS]).toEqual([
      "user",
      "timeout",
      "busy",
      "muted",
      "changed",
      "cancelled",
      "in-use",
    ]);
  });
});

describe("hello, welcome and discovery with roles", () => {
  test("a v2 hello needs a known role; a v1 hello carries none", () => {
    expect(errorsOf(hello())).toEqual([]);
    expect(errorsOf(hello({ role: "full" }))).toEqual([]);
    expect(errorsOf(hello({ role: "root" }))).toEqual(['role must be "agent" or "full"']);
    expect(errorsOf(hello({ role: undefined }))).toEqual(['role must be "agent" or "full"']);
    expect(errorsOf(hello({ protocol: 1 }))).toEqual(['unknown field "role"']);
    expect(errorsOf({ type: "hello", protocol: 1, nonce: NONCE })).toEqual([]);
    expect(errorsOf(hello({ token: TOKEN }))).toEqual(['unknown field "token"']);
  });

  test("a v2 welcome names the role", () => {
    const welcome = { type: "welcome", protocol: 2, app: "Vimma", version: "1" };
    expect(errorsOf({ ...welcome, role: "agent" })).toEqual([]);
    expect(errorsOf(welcome)).toEqual(['role must be "agent" or "full"']);
    expect(errorsOf({ ...welcome, protocol: 1 })).toEqual([]);
  });

  test("a v2 discovery file lists one or both roles, never twice", () => {
    const d = { protocol: 2, port: 4000, token: TOKEN, pid: 7 };
    const errors = (roles) => errorsOf({ ...d, roles }, { kind: "discovery" });
    expect(errors(["agent"])).toEqual([]);
    expect(errors(["full", "agent"])).toEqual([]);
    for (const bad of [[], ["agent", "agent"], ["root"], "agent", undefined]) {
      expect(errors(bad)).toEqual(['roles must be a list of "agent" and "full", each once']);
    }
    expect(errorsOf({ ...d, protocol: 1 }, { kind: "discovery" })).toEqual([]);
  });
});

describe("agent commands: args", () => {
  test("agent-hello: a printable client name of at most 64, a version, a via token", () => {
    expect(errorsOf(req("agent-hello", { client: { name: "codex" } }))).toEqual([]);
    expect(
      errorsOf(req("agent-hello", { client: { name: "x", version: "1.0" }, via: "node" })),
    ).toEqual([]);
    expect(errorsOf(req("agent-hello", { client: { name: "x".repeat(65) } }))).toEqual([
      "client.name must be 1 to 64 printable characters",
    ]);
    for (const name of ["", "a\nb", "a‮b", "a\u0000", 7]) {
      expect(errorsOf(req("agent-hello", { client: { name } }))).toEqual([
        "client.name must be 1 to 64 printable characters",
      ]);
    }
    expect(errorsOf(req("agent-hello", { client: { name: "x" }, via: "x".repeat(33) }))).toEqual([
      "via must be 1 to 32 printable characters",
    ]);
    expect(errorsOf(req("agent-hello", { client: { name: "x", pid: 1 } }))).toEqual([
      'unknown field "args.client.pid"',
    ]);
    expect(errorsOf(req("agent-hello", {}))).toEqual(["client must be an object"]);
  });

  test("tab ids are browserIds: digits, as state gives them", () => {
    expect(errorsOf(req("agent-close", { tab: "12" }))).toEqual([]);
    for (const tab of ["", "0", "01", "1e3", "-1", 12, "1".repeat(17)]) {
      expect(errorsOf(req("agent-close", { tab }))).toEqual(["tab must be a tab id (digits)"]);
    }
  });

  test("agent-read: format markdown or text, max_chars 1..500000", () => {
    expect(errorsOf(req("agent-read", { tab: "3", format: "markdown" }))).toEqual([]);
    expect(errorsOf(req("agent-read", { tab: "3", max_chars: 500000 }))).toEqual([]);
    expect(errorsOf(req("agent-read", { tab: "3", format: "html" }))).toEqual([
      'format must be "markdown" or "text"',
    ]);
    for (const max of [0, 500001, 1.5, "10"]) {
      expect(errorsOf(req("agent-read", { tab: "3", max_chars: max }))).toEqual([
        "max_chars must be an integer from 1 to 500000",
      ]);
    }
    expect(errorsOf(req("agent-read", { tab: "3", selector: "body" }))).toEqual([
      'unknown field "args.selector"',
    ]);
  });

  test("agent-open: only http and https, at most 65536 characters, an optional tab", () => {
    expect(errorsOf(req("agent-open", { url: "https://docs.rs/" }))).toEqual([]);
    expect(errorsOf(req("agent-open", { url: "HTTP://A.example/", tab: "4" }))).toEqual([]);
    for (const url of [
      "file:///etc/passwd",
      "about:config",
      "javascript:alert(1)",
      "data:text/html,x",
      "view-source:https://a/",
    ]) {
      expect(errorsOf(req("agent-open", { url }))).toEqual(["url scheme must be http or https"]);
    }
    expect(errorsOf(req("agent-open", { url: `https://a/${"x".repeat(65527)}` }))).toEqual([
      "url must be at most 65536 characters",
    ]);
    expect(errorsOf(req("agent-open", { url: "https://a/ b" }))).toEqual([
      "url must not contain control characters or spaces",
    ]);
    expect(errorsOf(req("agent-open", { url: "https://a/", where: "tab" }))).toEqual([
      'unknown field "args.where"',
    ]);
  });

  // MCP's notifications/cancelled (vimma-mcp decision 17, sub-PR 3): withdraw one question.
  test("agent-cancel takes one request id of the connection", () => {
    expect(errorsOf(req("agent-cancel", { id: 4 }))).toEqual([]);
    expect(errorsOf(req("agent-cancel", { id: 2 ** 53 - 1 }))).toEqual([]);
    for (const id of [0, -1, 1.5, "4", null, 2 ** 53]) {
      expect(errorsOf(req("agent-cancel", { id })), String(id)).toEqual([
        "id must be an integer from 1 to 2^53-1",
      ]);
    }
    expect(errorsOf(req("agent-cancel", {}))).toEqual(["id must be an integer from 1 to 2^53-1"]);
    expect(errorsOf(req("agent-cancel", { id: 4, all: true }))).toEqual([
      'unknown field "args.all"',
    ]);
  });

  // docs/specs/mcp-drive.md D15: the keys' limits the browser checks again (security.md M20).
  test("agent-keys: a tab and 1 to 512 characters of keys, no control characters", () => {
    expect(errorsOf(req("agent-keys", { tab: "12", keys: "3j /pricing<CR> gg" }))).toEqual([]);
    expect(errorsOf(req("agent-keys", { tab: "12", keys: "j\tk" }))).toEqual([]);
    expect(errorsOf(req("agent-keys", { tab: "12", keys: "é".repeat(512) }))).toEqual([]);
    for (const keys of ["", "j".repeat(513), 3, null]) {
      expect(errorsOf(req("agent-keys", { tab: "12", keys })), String(keys)).toEqual([
        "keys must be a string of 1 to 512 characters",
      ]);
    }
    for (const keys of ["j\n", "\u0000", "\u007f", "\u009b"]) {
      expect(errorsOf(req("agent-keys", { tab: "12", keys })), keys).toEqual([
        "keys must not contain control characters",
      ]);
    }
    expect(errorsOf(req("agent-keys", { keys: "j" }))).toEqual(["tab must be a tab id (digits)"]);
    expect(errorsOf(req("agent-keys", { tab: "1", keys: "j", show: true }))).toEqual([
      'unknown field "args.show"',
    ]);
  });

  test("agent-tabs and agent-ping take no args", () => {
    expect(errorsOf(req("agent-tabs"))).toEqual([]);
    expect(errorsOf(req("agent-ping", { x: 1 }))).toEqual(['unknown field "args.x"']);
  });
});

describe("agent commands: results and errors", () => {
  test("agent-tabs lists id, url, title and loading for each tab", () => {
    const tab = { id: "1", url: "https://a/", title: "A", loading: false };
    expect(errorsOf(ok({ tabs: [tab] }), { command: "agent-tabs" })).toEqual([]);
    expect(errorsOf(ok({ tabs: [{ ...tab, url: null }] }), { command: "agent-tabs" })).toEqual([
      "result.tabs[0].url must be a string",
    ]);
  });

  test("agent-read: strings, flags, and a selection or language that may be null", () => {
    const read = {
      url: "https://a/",
      title: "A",
      text: "x",
      truncated: true,
      selection: "y",
      language: null,
      background: false,
    };
    expect(errorsOf(ok(read), { command: "agent-read" })).toEqual([]);
    expect(errorsOf(ok({ ...read, background: 1 }), { command: "agent-read" })).toEqual([
      "result.background must be a boolean",
    ]);
    expect(errorsOf(ok({ ...read, selection: 3 }), { command: "agent-read" })).toEqual([
      "result.selection must be a string or null",
    ]);
  });

  test("agent-keys: the page after the steps, and why it stopped", () => {
    const keys = {
      url: "https://a/",
      title: "A",
      loading: false,
      scroll: { y: 0.42 },
      steps: [{ keys: "3j", action: "scroll.down", ok: true }],
    };
    const cmd = { command: "agent-keys" };
    expect(errorsOf(ok(keys), cmd)).toEqual([]);
    const found = { query: "x", found: true, wrapped: false };
    const note = [{ keys: "gu", action: "page.url_up", ok: false, note: "already at the top" }];
    expect(errorsOf(ok({ ...keys, steps: note, stopped: "changed", find: found }), cmd)).toEqual(
      [],
    );
    expect(errorsOf(ok({ ...keys, scroll: { y: 1.5 } }), cmd)).toEqual([
      "result.scroll.y must be a number from 0 to 1",
    ]);
    expect(errorsOf(ok({ ...keys, stopped: "bored" }), cmd)).toEqual([
      "result.stopped must be one of changed, in-use, timeout, denied",
    ]);
    expect(errorsOf(ok({ ...keys, steps: [{ keys: "j", action: "scroll.down" }] }), cmd)).toEqual([
      "result.steps[0].ok must be a boolean",
    ]);
    expect(errorsOf(ok({ ...keys, find: { query: "x", found: "yes" } }), cmd)).toEqual([
      "result.find.found must be a boolean",
      "result.find.wrapped must be a boolean",
    ]);
    expect(errorsOf(ok({ ...keys, links: "x" }), cmd)).toEqual(['unknown field "result.links"']);
  });

  test("agent-cancel says whether a question was withdrawn", () => {
    expect(errorsOf(ok({ cancelled: false }), { command: "agent-cancel" })).toEqual([]);
    expect(errorsOf(ok({}), { command: "agent-cancel" })).toEqual([
      "result.cancelled must be a boolean",
    ]);
  });

  test("a denial names its reason; no other error carries one", () => {
    const denied = (reason) => ({
      type: "response",
      id: 1,
      ok: false,
      error: { code: "denied", message: "no", ...(reason ? { reason } : {}) },
    });
    for (const reason of DENY_REASONS) expect(errorsOf(denied(reason))).toEqual([]);
    expect(errorsOf(denied())).toEqual([
      "error.reason must be one of user, timeout, busy, muted, changed, cancelled, in-use",
    ]);
    const other = { code: "failed", message: "m", reason: "user" };
    expect(errorsOf({ type: "response", id: 1, ok: false, error: other })).toEqual([
      "error.reason is only for denied",
    ]);
  });
});

// The full-control question shows a code the client printed (security.md S13).
describe("auth's code", () => {
  const auth = (extra = {}) => ({ type: "auth", token: TOKEN, ...extra });
  test("optional; 4 characters of 2-9 and A-Z without I and O", () => {
    expect(errorsOf(auth(), { kind: "auth" })).toEqual([]);
    expect(errorsOf(auth({ code: "7F3K" }), { kind: "auth" })).toEqual([]);
    expect(errorsOf(auth({ code: "A2Z9" }), { kind: "auth" })).toEqual([]);
    for (const code of ["7f3k", "7F3", "7F3KK", "IO11", "7F 3", 1234, null]) {
      expect(errorsOf(auth({ code }), { kind: "auth" }).join(), String(code)).toMatch(/code/);
    }
  });
});
