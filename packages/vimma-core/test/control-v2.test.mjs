// Control protocol 2 (docs/specs/vimma-mcp.md, decisions 2 and 4): the hello's role, the agent
// commands, `role-off` and `denied`. Fixtures in tests/contract/control/v2/; v1's are unchanged.
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ACTIVATE_CHANGES,
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
      "agent-show",
      "agent-elements",
      "agent-activate",
      "agent-fill",
      "agent-screenshot",
      "agent-console",
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

  // docs/specs/mcp-session-grants.md S4: the session id of one vimma-ctl mcp process.
  test("agent-hello: a session id of 32 to 128 lowercase hex characters", () => {
    const hello = (/** @type {unknown} */ session) =>
      errorsOf(req("agent-hello", { client: { name: "x" }, session }));
    expect(hello("a".repeat(32))).toEqual([]);
    expect(hello("0123456789abcdef".repeat(8))).toEqual([]);
    for (const session of ["a".repeat(31), "a".repeat(129), "A".repeat(64), "g".repeat(64), 7]) {
      expect(hello(session)).toEqual(["session must be 32 to 128 lowercase hex characters"]);
    }
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

  // docs/specs/mcp-drive.md D2: a show names one tab and nothing else, never a workspace.
  test("agent-show: a tab and no other field", () => {
    expect(errorsOf(req("agent-show", { tab: "12" }))).toEqual([]);
    expect(errorsOf(req("agent-show", {}))).toEqual(["tab must be a tab id (digits)"]);
    expect(errorsOf(req("agent-show", { tab: "12", workspace: "main" }))).toEqual([
      'unknown field "args.workspace"',
    ]);
  });

  // docs/specs/mcp-forms.md F2: a list names one tab and nothing else.
  test("agent-elements: a tab and no other field", () => {
    expect(errorsOf(req("agent-elements", { tab: "12" }))).toEqual([]);
    expect(errorsOf(req("agent-elements", {}))).toEqual(["tab must be a tab id (digits)"]);
    expect(errorsOf(req("agent-elements", { tab: "12", selector: "form" }))).toEqual([
      'unknown field "args.selector"',
    ]);
  });

  // docs/specs/mcp-forms.md F18, F20: a screenshot names one tab, and whether to draw the labels.
  test("agent-screenshot: a tab and an optional labels flag, nothing else", () => {
    const shot = (args) => errorsOf(req("agent-screenshot", args));
    expect(shot({ tab: "12" })).toEqual([]);
    expect(shot({ tab: "12", labels: true })).toEqual([]);
    expect(shot({ tab: "12", labels: false })).toEqual([]);
    expect(shot({})).toEqual(["tab must be a tab id (digits)"]);
    expect(shot({ tab: "12", labels: "yes" })).toEqual(["labels must be a boolean"]);
    expect(shot({ tab: "12", rect: { x: 0 } })).toEqual(['unknown field "args.rect"']);
  });

  // docs/specs/mcp-forms.md F22: a console read names one tab, and optionally a time.
  test("agent-console: a tab and an optional since, nothing else", () => {
    const read = (args) => errorsOf(req("agent-console", args));
    expect(read({ tab: "12" })).toEqual([]);
    expect(read({ tab: "12", since: 0 })).toEqual([]);
    expect(read({ tab: "12", since: 1_761_000_000_000 })).toEqual([]);
    expect(read({})).toEqual(["tab must be a tab id (digits)"]);
    const since = "since must be a non-negative integer (ms since the epoch)";
    expect(read({ tab: "12", since: -1 })).toEqual([since]);
    expect(read({ tab: "12", since: 1.5 })).toEqual([since]);
    expect(read({ tab: "12", since: "1" })).toEqual([since]);
    expect(read({ tab: "12", since: 2 ** 53 })).toEqual([since]);
    expect(read({ tab: "12", expression: "1+1" })).toEqual(['unknown field "args.expression"']);
  });

  // docs/specs/mcp-forms.md F8: a click names one tab and one label from vimma_elements.
  test("agent-activate: a tab and a label of hint characters, nothing else", () => {
    expect(errorsOf(req("agent-activate", { tab: "12", label: "sd" }))).toEqual([]);
    expect(errorsOf(req("agent-activate", { tab: "12" }))).toEqual([
      "label must be 1 to 3 of the hint characters asdfghjkl",
    ]);
    for (const label of ["", "x", "SD", "asdf", 3]) {
      expect(errorsOf(req("agent-activate", { tab: "12", label })), String(label)).toEqual([
        "label must be 1 to 3 of the hint characters asdfghjkl",
      ]);
    }
    expect(errorsOf(req("agent-activate", { label: "sd" }))).toEqual([
      "tab must be a tab id (digits)",
    ]);
    expect(errorsOf(req("agent-activate", { tab: "12", label: "sd", x: 1, y: 2 }))).toEqual([
      'unknown field "args.x"',
      'unknown field "args.y"',
    ]);
  });

  // docs/specs/mcp-forms.md F12, F14, F15: a fill names one tab, 1 to 32 fields by label with a
  // text or a true or false, and an optional submit: true or a submit button's label.
  test("agent-fill: a tab, fields by label and value, an optional submit", () => {
    const fill = (args) => errorsOf(req("agent-fill", args));
    const sd = { label: "sd", value: "ada@example.com" };
    expect(fill({ tab: "12", fields: [sd] })).toEqual([]);
    expect(fill({ tab: "12", fields: [sd, { label: "sf", value: true }], submit: true })).toEqual(
      [],
    );
    expect(fill({ tab: "12", fields: [sd], submit: "sg" })).toEqual([]);
    expect(fill({ tab: "12", fields: [{ label: "sd", value: "two\nlines" }] })).toEqual([]);
    expect(fill({ tab: "12", fields: [{ label: "sd", value: "x".repeat(1024) }] })).toEqual([]);
    // 1,024 characters are code points: an emoji is one.
    expect(fill({ tab: "12", fields: [{ label: "sd", value: "😀".repeat(1024) }] })).toEqual([]);
    const list = "fields must be a list of 1 to 32 fields";
    expect(fill({ tab: "12" })).toEqual([list]);
    expect(fill({ tab: "12", fields: [] })).toEqual([list]);
    expect(fill({ tab: "12", fields: sd })).toEqual([list]);
    const many = Array.from({ length: 33 }, (_, i) => ({ label: "asdfghjkl"[i % 9], value: "x" }));
    expect(fill({ tab: "12", fields: many })).toEqual([list]);
    expect(fill({ tab: "12", fields: [sd, { ...sd, value: "y" }] })).toEqual([
      "fields must name each label once",
    ]);
    expect(fill({ tab: "12", fields: [{ label: "x", value: "y" }] })).toEqual([
      "args.fields[0].label must be 1 to 3 of the hint characters asdfghjkl",
    ]);
    const value =
      "args.fields[0].value must be true, false or a text of at most 1024 characters " +
      "without control or invisible characters but line breaks";
    // Characters that draw nothing could hide text in the question (M27).
    for (const v of [
      "x".repeat(1025),
      "a\u0000b",
      "a\rb",
      "a\tb",
      "a\u200bb",
      "a\u200db",
      "a\u2060b",
      "a\ufeffb",
      "a\u202eb",
      "a\u2028b",
      "a\ufe0fb",
      "a\u{e0041}b",
      "a\u{e0100}b",
      "a\u00adb",
      "a\u034fb",
      "a\u3164b",
      3,
      null,
      ["x"],
    ]) {
      expect(fill({ tab: "12", fields: [{ label: "sd", value: v }] }), JSON.stringify(v)).toEqual([
        value,
      ]);
    }
    expect(fill({ tab: "12", fields: [{ ...sd, selector: "#email" }] })).toEqual([
      'unknown field "args.fields[0].selector"',
    ]);
    expect(fill({ tab: "12", fields: ["sd"] })).toEqual(["args.fields[0] must be an object"]);
    for (const submit of [false, "x", "#go", 1, null]) {
      expect(fill({ tab: "12", fields: [sd], submit }), String(submit)).toEqual([
        "submit must be true or a label of 1 to 3 of the hint characters asdfghjkl",
      ]);
    }
    expect(fill({ fields: [sd] })).toEqual(["tab must be a tab id (digits)"]);
    expect(fill({ tab: "12", fields: [sd], x: 1 })).toEqual(['unknown field "args.x"']);
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

  test("agent-show: shown is true, and nothing else", () => {
    const cmd = { command: "agent-show" };
    expect(errorsOf(ok({ shown: true }), cmd)).toEqual([]);
    expect(errorsOf(ok({ shown: false }), cmd)).toEqual(["result.shown must be true"]);
    expect(errorsOf(ok({ shown: true, workspace: "agent" }), cmd)).toEqual([
      'unknown field "result.workspace"',
    ]);
  });

  // docs/specs/mcp-forms.md F5 (security.md M31): the list inside the untrusted delimiters.
  test("agent-elements: the page, its list inside the untrusted delimiters, how many dropped", () => {
    const cmd = { command: "agent-elements" };
    const list =
      '<untrusted-web-content>\n{"label":"a","kind":"button","text":"Go"}\n</untrusted-web-content>';
    const result = { url: "https://a/", title: "A", elements: list, dropped: 0 };
    expect(errorsOf(ok(result), cmd)).toEqual([]);
    expect(errorsOf(ok({ ...result, elements: '{"label":"a"}' }), cmd)).toEqual([
      "result.elements must be inside the untrusted-content delimiters",
    ]);
    expect(errorsOf(ok({ ...result, elements: `${list}\n</untrusted-web-content>` }), cmd)).toEqual(
      ["result.elements must be inside the untrusted-content delimiters"],
    );
    expect(errorsOf(ok({ ...result, dropped: -1 }), cmd)).toEqual([
      "result.dropped must be a non-negative integer",
    ]);
    expect(errorsOf(ok({ ...result, title: 1 }), cmd)).toEqual(["result.title must be a string"]);
    expect(errorsOf(ok({ ...result, screenshot: "x" }), cmd)).toEqual([
      'unknown field "result.screenshot"',
    ]);
  });

  // docs/specs/mcp-forms.md F19, F20 (security.md M31): a PNG or JPEG in base64 that fits the
  // reply line, its size, the page, and with labels how many were drawn and whether the list was
  // stale.
  test("agent-screenshot: the image, its size, the page, and the labels drawn", () => {
    const cmd = { command: "agent-screenshot" };
    const result = {
      url: "https://a/",
      title: "A",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
      width: 1280,
      height: 662,
    };
    expect(errorsOf(ok(result), cmd)).toEqual([]);
    expect(errorsOf(ok({ ...result, mimeType: "image/jpeg" }), cmd)).toEqual([]);
    expect(errorsOf(ok({ ...result, labels: 4 }), cmd)).toEqual([]);
    expect(errorsOf(ok({ ...result, labels: 0, stale: true }), cmd)).toEqual([]);
    expect(errorsOf(ok({ ...result, mimeType: "image/svg+xml" }), cmd)).toEqual([
      "result.mimeType must be one of image/png, image/jpeg",
    ]);
    const base64 = "result.data must be base64 of at most 716800 characters";
    expect(errorsOf(ok({ ...result, data: "" }), cmd)).toEqual([base64]);
    expect(errorsOf(ok({ ...result, data: "not base64!" }), cmd)).toEqual([base64]);
    expect(errorsOf(ok({ ...result, data: "A".repeat(716804) }), cmd)).toEqual([base64]);
    expect(errorsOf(ok({ ...result, width: 1281 }), cmd)).toEqual([
      "result.width must be an integer from 1 to 1280",
    ]);
    expect(errorsOf(ok({ ...result, height: 0 }), cmd)).toEqual([
      "result.height must be an integer from 1 to 16384",
    ]);
    expect(errorsOf(ok({ ...result, labels: -1 }), cmd)).toEqual([
      "result.labels must be a non-negative integer",
    ]);
    expect(errorsOf(ok({ ...result, stale: true }), cmd)).toEqual([
      "result.stale comes only with result.labels",
    ]);
    expect(errorsOf(ok({ ...result, stale: false, labels: 0 }), cmd)).toEqual([
      "result.stale must be true when present",
    ]);
    expect(errorsOf(ok({ ...result, html: "<p>" }), cmd)).toEqual(['unknown field "result.html"']);
  });

  // docs/specs/mcp-forms.md F22, F24 (security.md M31): both lists inside the untrusted
  // delimiters, Vimma's clock, and how many entries were left out.
  test("agent-console: the page, its errors and requests inside the delimiters, the time", () => {
    const cmd = { command: "agent-console" };
    const wrap = (t) => `<untrusted-web-content>\n${t}\n</untrusted-web-content>`;
    const result = {
      url: "https://a/",
      title: "A",
      time: 1_761_000_000_000,
      errors: wrap('{"level":"error","source":"script","message":"boom"}'),
      requests: wrap(""),
      dropped: 0,
    };
    expect(errorsOf(ok(result), cmd)).toEqual([]);
    expect(errorsOf(ok({ ...result, errors: '{"level":"error"}' }), cmd)).toEqual([
      "result.errors must be inside the untrusted-content delimiters",
    ]);
    expect(errorsOf(ok({ ...result, requests: `${wrap("")}${wrap("")}` }), cmd)).toEqual([
      "result.requests must be inside the untrusted-content delimiters",
    ]);
    expect(errorsOf(ok({ ...result, time: -1 }), cmd)).toEqual([
      "result.time must be a non-negative integer",
    ]);
    expect(errorsOf(ok({ ...result, dropped: 0.5 }), cmd)).toEqual([
      "result.dropped must be a non-negative integer",
    ]);
    expect(errorsOf(ok({ ...result, url: 1 }), cmd)).toEqual(["result.url must be a string"]);
    expect(errorsOf(ok({ ...result, value: "42" }), cmd)).toEqual(['unknown field "result.value"']);
  });

  // docs/specs/mcp-forms.md F11, F16: the page after the click, a dialog's text inside the
  // untrusted delimiters, a submission Vimma stopped, and why the wait stopped.
  test("agent-activate: the page after the click, a dialog, a stopped submission", () => {
    const cmd = { command: "agent-activate" };
    const result = { url: "https://a/", title: "A", loading: false, navigated: true };
    expect(errorsOf(ok(result), cmd)).toEqual([]);
    const dialog = {
      type: "confirm",
      text: "<untrusted-web-content>\nSure?\n</untrusted-web-content>",
    };
    const full = { ...result, dialog, blocked: "example.com", stopped: "in-use" };
    expect(errorsOf(ok(full), cmd)).toEqual([]);
    expect(errorsOf(ok({ ...result, navigated: "yes" }), cmd)).toEqual([
      "result.navigated must be a boolean",
    ]);
    expect(errorsOf(ok({ ...result, dialog: { type: "print", text: dialog.text } }), cmd)).toEqual([
      "result.dialog.type must be one of alert, confirm, prompt",
    ]);
    expect(errorsOf(ok({ ...result, dialog: { type: "alert", text: "Sure?" } }), cmd)).toEqual([
      "result.dialog.text must be inside the untrusted-content delimiters",
    ]);
    expect(errorsOf(ok({ ...result, dialog: { ...dialog, x: 1 } }), cmd)).toEqual([
      'unknown field "result.dialog.x"',
    ]);
    expect(errorsOf(ok({ ...result, blocked: "a b" }), cmd)).toEqual([
      "result.blocked must be a host",
    ]);
    expect(errorsOf(ok({ ...result, stopped: "bored" }), cmd)).toEqual([
      "result.stopped must be in-use",
    ]);
    expect(errorsOf(ok({ ...result, steps: [] }), cmd)).toEqual(['unknown field "result.steps"']);
  });

  // #510: after a click that loaded no page, which parts of it changed in place, as fixed words
  // only, never the page's text.
  test("agent-activate: what changed in place, from a fixed list", () => {
    const cmd = { command: "agent-activate" };
    const result = { url: "https://a/", title: "A", loading: false, navigated: false };
    for (const changed of [[], ["element"], ["element", "elements", "text", "dialog"]]) {
      expect(errorsOf(ok({ ...result, changed }), cmd), JSON.stringify(changed)).toEqual([]);
    }
    for (const changed of ["text", ["price"], ["text", "text"], [1], { element: true }]) {
      expect(errorsOf(ok({ ...result, changed }), cmd), JSON.stringify(changed)).toEqual([
        `result.changed must be a list of distinct ${ACTIVATE_CHANGES.join(", ")}`,
      ]);
    }
  });

  // docs/specs/mcp-forms.md F12, F16: how many fields were filled, which did not keep their
  // value, then the page as after a click.
  test("agent-fill: the fields filled, those the page reset, the page after it", () => {
    const cmd = { command: "agent-fill" };
    const result = { url: "https://a/", title: "A", filled: 2, loading: false, navigated: false };
    expect(errorsOf(ok(result), cmd)).toEqual([]);
    const dialog = {
      type: "alert",
      text: "<untrusted-web-content>\nSaved\n</untrusted-web-content>",
    };
    const full = { ...result, reset: ["sd"], dialog, blocked: "example.com", stopped: "in-use" };
    expect(errorsOf(ok(full), cmd)).toEqual([]);
    expect(errorsOf(ok({ ...result, filled: -1 }), cmd)).toEqual([
      "result.filled must be a non-negative integer",
    ]);
    expect(errorsOf(ok({ ...result, filled: undefined }), cmd)).toEqual([
      "result.filled must be a non-negative integer",
    ]);
    for (const reset of ["sd", ["x"], [1]]) {
      expect(errorsOf(ok({ ...result, reset }), cmd), JSON.stringify(reset)).toEqual([
        "result.reset must be a list of labels",
      ]);
    }
    expect(errorsOf(ok({ ...result, dialog: { type: "alert", text: "Saved" } }), cmd)).toEqual([
      "result.dialog.text must be inside the untrusted-content delimiters",
    ]);
    expect(errorsOf(ok({ ...result, navigated: "no" }), cmd)).toEqual([
      "result.navigated must be a boolean",
    ]);
    expect(errorsOf(ok({ ...result, elements: "", dropped: 0 }), cmd)).toEqual([
      "result.elements must be inside the untrusted-content delimiters",
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
    expect(errorsOf(ok({ ...keys, extra: "x" }), cmd)).toEqual(['unknown field "result.extra"']);
  });

  // mcp-drive D12, D16 (security.md M21): `f`'s link list is one string inside the
  // untrusted-content delimiters, with how many links were left out.
  test("agent-keys: a link list inside the untrusted delimiters, and how many were dropped", () => {
    const keys = {
      url: "https://a/",
      title: "A",
      loading: false,
      scroll: { y: 0 },
      steps: [{ keys: "f", action: "hint.follow", ok: true }],
    };
    const cmd = { command: "agent-keys" };
    const links = '<untrusted-web-content>\na "A" https://a/b\n</untrusted-web-content>';
    expect(errorsOf(ok({ ...keys, links, dropped: 3 }), cmd)).toEqual([]);
    expect(errorsOf(ok({ ...keys, links: "a https://a/b", dropped: 0 }), cmd)).toEqual([
      "result.links must be inside the untrusted-content delimiters",
    ]);
    const twice = `${links}\n${links}`;
    expect(errorsOf(ok({ ...keys, links: twice, dropped: 0 }), cmd)).toEqual([
      "result.links must be inside the untrusted-content delimiters",
    ]);
    expect(errorsOf(ok({ ...keys, links: 3, dropped: 0 }), cmd)).toEqual([
      "result.links must be inside the untrusted-content delimiters",
    ]);
    expect(errorsOf(ok({ ...keys, links, dropped: -1 }), cmd)).toEqual([
      "result.dropped must be a non-negative integer",
    ]);
    expect(errorsOf(ok({ ...keys, links }), cmd)).toEqual([
      "result.links and result.dropped come together",
    ]);
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

  // Issue #592: a used-up rate is busy with the time until the next call is allowed.
  test("retryAfter: 1 to 60000 whole milliseconds, on a busy denial only", () => {
    const denied = (reason, retryAfter) => ({
      type: "response",
      id: 1,
      ok: false,
      error: { code: "denied", message: "too many", reason, retryAfter },
    });
    for (const ms of [1, 12_000, 60_000]) expect(errorsOf(denied("busy", ms))).toEqual([]);
    const bad = "error.retryAfter must be a whole number from 1 to 60000";
    for (const ms of [0, -1, 1.5, 60_001, "5", null]) {
      expect(errorsOf(denied("busy", ms))).toEqual([bad]);
    }
    expect(errorsOf(denied("user", 5))).toEqual(["error.retryAfter is only for a busy denial"]);
    const other = { code: "failed", message: "m", retryAfter: 5 };
    expect(errorsOf({ type: "response", id: 1, ok: false, error: other })).toEqual([
      "error.retryAfter is only for a busy denial",
    ]);
  });
});

// Issue #584: an open, a click or a fill may return the page's new element list, under the same
// rules as agent-elements' (security.md M31); a screenshot is smaller unless asked full.
describe("element lists in a step's result (#584)", () => {
  const wrap = (t) => `<untrusted-web-content>\n${t}\n</untrusted-web-content>`;
  const list = wrap('{"label":"a","kind":"button","text":"Go"}');

  test("agent-open, agent-activate and agent-fill take an optional elements flag", () => {
    const fields = [{ label: "sd", value: "x" }];
    for (const [command, args] of [
      ["agent-open", { url: "https://a/" }],
      ["agent-open", { url: "https://a/", tab: "4" }],
      ["agent-activate", { tab: "12", label: "sd" }],
      ["agent-fill", { tab: "12", fields }],
      ["agent-fill", { tab: "12", fields, submit: true }],
    ]) {
      expect(errorsOf(req(command, { ...args, elements: true })), command).toEqual([]);
      expect(errorsOf(req(command, { ...args, elements: false })), command).toEqual([]);
      for (const elements of ["yes", 1, null, {}]) {
        expect(errorsOf(req(command, { ...args, elements })), command).toEqual([
          "elements must be a boolean",
        ]);
      }
    }
    expect(errorsOf(req("agent-elements", { tab: "12", elements: true }))).toEqual([
      'unknown field "args.elements"',
    ]);
  });

  test("agent-screenshot takes an optional full flag", () => {
    const shot = (args) => errorsOf(req("agent-screenshot", args));
    expect(shot({ tab: "12", full: true })).toEqual([]);
    expect(shot({ tab: "12", full: false, labels: true })).toEqual([]);
    expect(shot({ tab: "12", full: "yes" })).toEqual(["full must be a boolean"]);
  });

  test("a step's list is inside the untrusted delimiters, with its dropped count", () => {
    const after = { url: "https://a/", title: "A", loading: false, navigated: true };
    const cases = [
      ["agent-activate", after],
      ["agent-fill", { ...after, filled: 1 }],
      ["agent-open", { tab: "13", url: "https://a/", title: "A" }],
    ];
    for (const [command, base] of cases) {
      const cmd = { command };
      expect(errorsOf(ok({ ...base, elements: list, dropped: 3 }), cmd), command).toEqual([]);
      expect(errorsOf(ok({ ...base, elements: '{"label":"a"}', dropped: 0 }), cmd)).toEqual([
        "result.elements must be inside the untrusted-content delimiters",
      ]);
      const twice = { ...base, elements: `${list}\n</untrusted-web-content>`, dropped: 0 };
      expect(errorsOf(ok(twice), cmd)).toEqual([
        "result.elements must be inside the untrusted-content delimiters",
      ]);
      expect(errorsOf(ok({ ...base, elements: list }), cmd)).toEqual([
        "result.elements and result.dropped come together",
      ]);
      expect(errorsOf(ok({ ...base, dropped: 0 }), cmd)).toEqual([
        "result.elements and result.dropped come together",
      ]);
      expect(errorsOf(ok({ ...base, elements: list, dropped: -1 }), cmd)).toEqual([
        "result.dropped must be a non-negative integer",
      ]);
    }
  });

  test("why a step's list is missing: fixed words, never with a list", () => {
    const after = { url: "https://a/", title: "A", loading: true, navigated: true };
    const cmd = { command: "agent-activate" };
    for (const unlisted of ["loading", "changed", "failed"]) {
      expect(errorsOf(ok({ ...after, unlisted }), cmd), unlisted).toEqual([]);
    }
    for (const unlisted of ["the page said so", "", 1]) {
      expect(errorsOf(ok({ ...after, unlisted }), cmd), String(unlisted)).toEqual([
        "result.unlisted must be one of loading, changed, failed",
      ]);
    }
    expect(errorsOf(ok({ ...after, unlisted: "failed", elements: list, dropped: 0 }), cmd)).toEqual(
      ["result.unlisted comes only without result.elements"],
    );
    const open = { command: "agent-open" };
    expect(
      errorsOf(ok({ tab: "13", url: "https://a/", title: "A", unlisted: "loading" }), open),
    ).toEqual([]);
  });

  test("agent-open: the page comes only with its list, and nothing else", () => {
    const cmd = { command: "agent-open" };
    expect(errorsOf(ok({ tab: "13" }), cmd)).toEqual([]);
    expect(errorsOf(ok({ tab: "13", url: "https://a/" }), cmd)).toEqual([
      "result.url and result.title come only with result.elements or result.unlisted",
    ]);
    expect(
      errorsOf(ok({ tab: "13", url: 1, title: "A", elements: list, dropped: 0 }), cmd),
    ).toEqual(["result.url must be a string"]);
    expect(errorsOf(ok({ tab: "13", text: "x" }), cmd)).toEqual(['unknown field "result.text"']);
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
