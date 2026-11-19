// Edges of the control protocol's validator and framing (docs/security/01-control-socket.md
// S4, S5, S7, S10, S11; docs/security/12-agents-mcp.md for the agent commands): each boundary
// and each refusal the mutation run (issue #1119) found unpinned. Accepted values sit exactly on
// a limit; refused ones are one step past it, or of a type a loose check would coerce.
import { describe, test, expect, vi } from "vitest";
import {
  LineFramer,
  parseAgentRequest,
  tokensEqual,
  validateMessage,
} from "../src/control/control.mjs";
import type { ValidateOptions } from "../src/control/control.mjs";
import { AGENT_FILL, AGENT_SCREENSHOT } from "../src/agent/agent-act.mjs";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../src/agent/agent.mjs";

const NONCE = "fedcba9876543210".repeat(4);
const TOKEN = "0123456789abcdef".repeat(4);
const req = (command: string, args: Record<string, unknown> = {}) => ({
  type: "request",
  id: 1,
  command,
  args,
});
const valid = (message: unknown, options?: ValidateOptions) =>
  validateMessage(message, options).valid;
const errorsOf = (message: unknown, options?: ValidateOptions) =>
  validateMessage(message, options).errors;
const response = (command: string, result: unknown) =>
  validateMessage({ type: "response", id: 1, ok: true, result }, { command });
const fenced = (text: string) => `${UNTRUSTED_OPEN}\n${text}\n${UNTRUSTED_CLOSE}`;
const named = (name: string) => req("agent-hello", { client: { name } });
/** A code point as a test name shows it (U+202E), with the code point itself. */
const hex = (cp: number): [string, number] => [cp.toString(16).toUpperCase().padStart(4, "0"), cp];

describe("a label shown in the question: printable only (S11)", () => {
  // C0, DEL and C1, and the bidi marks, overrides and isolates, at both ends of each range.
  test.each(
    [0x00, 0x1f, 0x7f, 0x80, 0x9f, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069].map(hex),
  )("U+%s in a client name is refused", (_, cp) => {
    expect(valid(named(`a${String.fromCodePoint(cp)}b`))).toBe(false);
  });

  // One past each range, and letters well above the C1 block and the bidi ranges.
  test.each([0x20, 0x7e, 0xa0, 0xe9, 0x2010, 0x2030, 0x20ac].map(hex))(
    "U+%s in a client name is a printable character",
    (_, cp) => {
      expect(valid(named(`a${String.fromCodePoint(cp)}b`))).toBe(true);
    },
  );

  test("a name of 64 code points passes; 65 do not", () => {
    expect(valid(named("\u00e9".repeat(64)))).toBe(true);
    expect(valid(named("\u00e9".repeat(65)))).toBe(false);
  });

  test("client.version is held to the same rule as the name", () => {
    const hello = (version: unknown) => req("agent-hello", { client: { name: "agent", version } });
    expect(valid(hello("2.1.0"))).toBe(true);
    expect(errorsOf(hello("2.1\u202e0"))).toEqual([
      "client.version must be 1 to 64 printable characters",
    ]);
    expect(valid(hello(""))).toBe(false);
  });

  test("a session id is a string; an array holding one is refused (mcp-session-grants S4)", () => {
    const session = "0123456789abcdef".repeat(2);
    expect(valid(req("agent-hello", { client: { name: "a" }, session }))).toBe(true);
    expect(errorsOf(req("agent-hello", { client: { name: "a" }, session: [session] }))).toEqual([
      "session must be 32 to 128 lowercase hex characters",
    ]);
  });

  test("an unknown hello field is named with its args. prefix", () => {
    expect(errorsOf(req("agent-hello", { client: { name: "a" }, extra: 1 }))).toEqual([
      'unknown field "args.extra"',
    ]);
  });
});

describe("handshake (S4)", () => {
  test("a nonce, token or proof is a string of exactly 64 lowercase hex characters", () => {
    const hello = (nonce: unknown) => ({ type: "hello", protocol: 1, nonce });
    // An array holding the hex would pass a check that let the regex coerce it.
    expect(valid(hello([NONCE]))).toBe(false);
    expect(valid(hello(`x${NONCE}`))).toBe(false);
    expect(valid(hello(`${NONCE}0`))).toBe(false);
    expect(valid({ type: "auth", token: [TOKEN] })).toBe(false);
  });

  test("an auth's code is checked whenever it is present", () => {
    expect(valid({ type: "auth", token: TOKEN, code: "7F3K" })).toBe(true);
    expect(errorsOf({ type: "auth", token: TOKEN, code: "7f3k" })).toEqual([
      "code must be 4 characters of 2-9 and A-Z without I and O",
    ]);
    expect(valid({ type: "auth", token: TOKEN, code: 7234 })).toBe(false);
    // I, O, 0 and 1 are left out of the alphabet: each reads as another character.
    for (const code of ["7F3I", "7F3O", "7F30", "7F31"]) {
      expect(valid({ type: "auth", token: TOKEN, code })).toBe(false);
    }
  });

  test("a welcome's app is a string", () => {
    expect(errorsOf({ type: "welcome", protocol: 1, app: 1, version: "0.1.0" })).toEqual([
      "app must be a string",
    ]);
  });
});

describe("the discovery file", () => {
  const file = { protocol: 1, port: 4242, token: TOKEN, pid: 7 };
  test("roles, when a protocol 1 file has them, are checked as protocol 2's", () => {
    expect(valid({ ...file, roles: ["full"] }, { kind: "discovery" })).toBe(true);
    expect(valid({ ...file, roles: ["root"] }, { kind: "discovery" })).toBe(false);
  });

  test("every role is agent or full: one good role does not carry a bad one", () => {
    const v2 = { ...file, protocol: 2 };
    expect(valid({ ...v2, roles: ["agent", "full"] }, { kind: "discovery" })).toBe(true);
    expect(valid({ ...v2, roles: ["agent", "root"] }, { kind: "discovery" })).toBe(false);
  });

  test("a version that is not a Vimma version is named in the error", () => {
    expect(errorsOf({ ...file, version: "latest" }, { kind: "discovery" })).toEqual([
      "version must be a Vimma version (X.Y.Z)",
    ]);
  });
});

describe("full-role commands (S7, S10)", () => {
  test("send-keys takes 256 chords, not 257", () => {
    expect(valid(req("send-keys", { keys: Array(256).fill("j").join(" ") }))).toBe(true);
    expect(valid(req("send-keys", { keys: Array(257).fill("j").join(" ") }))).toBe(false);
  });

  test("open refuses a space, a control character and DEL in the URL", () => {
    for (const url of [
      "https://a.example/ b",
      "https://a.example/\u001fb",
      "https://a.example/\u007f",
    ]) {
      expect(errorsOf(req("open", { url }))).toEqual([
        "url must not contain control characters or spaces",
      ]);
    }
    expect(valid(req("open", { url: "https://a.example/!" }))).toBe(true);
  });

  test("open's scheme is the one the URL starts with, not one found later in it", () => {
    expect(errorsOf(req("open", { url: "1http://a.example/" }))).toEqual([
      "url must be an absolute URL",
    ]);
  });

  test("open takes a URL of exactly MAX_URL (65536) characters, not one more", () => {
    const at = (n: number) => `https://a.example/${"a".repeat(n - 18)}`;
    expect(at(65536)).toHaveLength(65536);
    expect(valid(req("open", { url: at(65536) }))).toBe(true);
    expect(errorsOf(req("open", { url: at(65537) }))).toEqual([
      "url must be at most 65536 characters",
    ]);
  });

  test("open's url must be a string", () => {
    expect(errorsOf(req("open", { url: 1 }))).toEqual(["url must be a string"]);
  });

  test("an unknown command is named with the list of known ones", () => {
    const [error] = errorsOf(req("rm", {}));
    expect(error).toMatch(/^command must be one of send-keys, state, open, reload-theme, /);
  });
});

describe("agent commands' arguments (12-agents-mcp)", () => {
  test("agent-read needs its tab", () => {
    expect(errorsOf(req("agent-read", {}))).toEqual(["tab must be a tab id (digits)"]);
  });

  test("agent-open: a string URL of at most 65536 characters, no DEL, a tab id if any", () => {
    const at = (n: number) => `https://a.example/${"a".repeat(n - 18)}`;
    expect(at(65536)).toHaveLength(65536);
    expect(valid(req("agent-open", { url: at(65536) }))).toBe(true);
    expect(valid(req("agent-open", { url: at(65537) }))).toBe(false);
    expect(errorsOf(req("agent-open", { url: 1 }))).toEqual(["url must be a string"]);
    expect(errorsOf(req("agent-open", { url: "https://a.example/\u007f" }))).toEqual([
      "url must not contain control characters or spaces",
    ]);
    expect(errorsOf(req("agent-open", { url: "https://a.example/", tab: "x" }))).toEqual([
      "tab must be a tab id (digits)",
    ]);
  });

  test("a step's query and kinds come only with elements: true, and are checked there", () => {
    const open = (extra: Record<string, unknown>) =>
      req("agent-open", { url: "https://a.example/", ...extra });
    expect(errorsOf(open({ kinds: ["link"] }))).toEqual([
      "query and kinds come only with elements: true",
    ]);
    expect(valid(open({ elements: true, kinds: ["link"] }))).toBe(true);
    expect(valid(open({ elements: true, query: "\u0007" }))).toBe(false);
  });

  test("a list query is not blank, and at most 200 code points", () => {
    const list = (query: string) => req("agent-elements", { tab: "1", query });
    expect(valid(list("   "))).toBe(false);
    expect(valid(list("\u00e9".repeat(200)))).toBe(true);
    expect(valid(list("\u00e9".repeat(201)))).toBe(false);
  });

  test("every kind is an element kind: one good kind does not carry a bad one", () => {
    expect(valid(req("agent-elements", { tab: "1", kinds: ["link", "script"] }))).toBe(false);
  });

  test("agent-fill takes as many fields as AGENT_FILL.fields, not one more", () => {
    const fields = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        label: "asdfghjkl".charAt(Math.floor(i / 9)) + "asdfghjkl".charAt(i % 9),
        value: "x",
      }));
    expect(valid(req("agent-fill", { tab: "1", fields: fields(AGENT_FILL.fields) }))).toBe(true);
    expect(valid(req("agent-fill", { tab: "1", fields: fields(AGENT_FILL.fields + 1) }))).toBe(
      false,
    );
  });
});

describe("parseAgentRequest: an argument not sent stays absent (S11)", () => {
  const keys = (command: string, args: Record<string, unknown>) =>
    Object.keys(parseAgentRequest(command, args)?.args ?? { refused: true }).sort();

  test.each([
    ["agent-hello", { client: { name: "a" } }, ["client"]],
    ["agent-open", { url: "https://a.example/" }, ["url"]],
    ["agent-read", { tab: "1" }, ["tab"]],
    ["agent-elements", { tab: "1" }, ["tab"]],
    ["agent-activate", { tab: "1", label: "a" }, ["label", "tab"]],
    ["agent-fill", { tab: "1", fields: [{ label: "a", value: "x" }] }, ["fields", "tab"]],
    ["agent-screenshot", { tab: "1" }, ["tab"]],
    ["agent-console", { tab: "1" }, ["tab"]],
  ])("%s with only what it needs", (command, args, expected) => {
    expect(keys(command, args)).toEqual(expected);
  });

  test("agent-hello's client has no version key unless one was sent", () => {
    const parsed = parseAgentRequest("agent-hello", { client: { name: "a" } });
    expect(parsed?.args).toStrictEqual({ client: { name: "a" } });
  });

  test("each format the validator accepts reaches the handler", () => {
    for (const format of ["markdown", "text"]) {
      expect(parseAgentRequest("agent-read", { tab: "1", format })?.args).toStrictEqual({
        tab: "1",
        format,
      });
    }
  });

  test("optional arguments sent are copied", () => {
    expect(
      parseAgentRequest("agent-elements", { tab: "1", query: "go", kinds: ["link"] })?.args,
    ).toStrictEqual({ tab: "1", query: "go", kinds: ["link"] });
    expect(
      parseAgentRequest("agent-fill", {
        tab: "1",
        fields: [{ label: "a", value: true }],
        submit: "s",
      })?.args,
    ).toStrictEqual({ tab: "1", fields: [{ label: "a", value: true }], submit: "s" });
  });
});

describe("agent results (12-agents-mcp M21, M31)", () => {
  test("a page's list is exactly one fenced block: nothing before or after, one of each fence", () => {
    const keysResult = (links: string) => ({
      url: "https://a.example/",
      title: "A",
      loading: false,
      scroll: { y: 0 },
      steps: [],
      links,
      dropped: 0,
    });
    expect(response("agent-keys", keysResult(fenced("a link"))).valid).toBe(true);
    expect(response("agent-keys", keysResult(`x${fenced("a link")}`)).valid).toBe(false);
    expect(response("agent-keys", keysResult(`${fenced("a link")}x`)).valid).toBe(false);
    expect(response("agent-keys", keysResult(fenced(`a ${UNTRUSTED_OPEN} b`))).valid).toBe(false);
  });

  describe("agent-keys", () => {
    const result = (extra: Record<string, unknown>) => ({
      url: "https://a.example/",
      title: "A",
      loading: false,
      scroll: { y: 0.5 },
      steps: [{ keys: "j", action: "scroll.down", ok: true }],
      ...extra,
    });

    test("url, title and loading are checked", () => {
      expect(response("agent-keys", result({})).valid).toBe(true);
      expect(response("agent-keys", result({ title: 1 })).errors).toEqual([
        "result.title must be a string",
      ]);
      expect(response("agent-keys", result({ loading: "no" })).errors).toEqual([
        "result.loading must be a boolean",
      ]);
    });

    test("scroll.y is a number from 0 to 1", () => {
      expect(response("agent-keys", result({ scroll: { y: 1 } })).valid).toBe(true);
      for (const y of ["0.5", -0.1, 1.1]) {
        expect(response("agent-keys", result({ scroll: { y } })).errors).toEqual([
          "result.scroll.y must be a number from 0 to 1",
        ]);
      }
    });

    test("steps is an array of objects with a string keys and note and a boolean ok", () => {
      expect(response("agent-keys", result({ steps: {} })).errors).toEqual([
        "result.steps must be an array",
      ]);
      expect(response("agent-keys", result({ steps: ["j"] })).errors).toEqual([
        "result.steps[0] must be an object",
      ]);
      const step = (extra: Record<string, unknown>) =>
        result({ steps: [{ keys: "j", action: "a", ok: true, ...extra }] });
      expect(response("agent-keys", step({ keys: 1 })).errors).toEqual([
        "result.steps[0].keys must be a string",
      ]);
      expect(response("agent-keys", step({ ok: "yes" })).errors).toEqual([
        "result.steps[0].ok must be a boolean",
      ]);
      expect(response("agent-keys", step({ note: 1 })).errors).toEqual([
        "result.steps[0].note must be a string",
      ]);
      expect(response("agent-keys", step({ more: 1 })).errors).toEqual([
        'unknown field "result.steps[0].more"',
      ]);
    });

    test("find is an object with a string query and boolean flags", () => {
      expect(response("agent-keys", result({ find: "x" })).errors).toEqual([
        "result.find must be an object",
      ]);
      expect(
        response("agent-keys", result({ find: { query: "x", found: 1, wrapped: false } })).errors,
      ).toEqual(["result.find.found must be a boolean"]);
      expect(
        response("agent-keys", result({ find: { query: 1, found: true, wrapped: false } })).errors,
      ).toEqual(["result.find.query must be a string"]);
    });
  });

  test("agent-hello answers a workspace name and whether it exists", () => {
    expect(response("agent-hello", { workspace: "agent", exists: true }).valid).toBe(true);
    expect(response("agent-hello", { workspace: 1, exists: true }).errors).toEqual([
      "result.workspace must be a string",
    ]);
    expect(response("agent-hello", { workspace: "agent", exists: "yes" }).errors).toEqual([
      "result.exists must be a boolean",
    ]);
  });

  test("agent-tabs answers an array of tab objects", () => {
    expect(response("agent-tabs", { tabs: {} }).errors).toEqual(["result.tabs must be an array"]);
    expect(response("agent-tabs", { tabs: ["12"] }).errors).toEqual([
      "result.tabs[0] must be an object",
    ]);
  });

  test("agent-read's text is a string", () => {
    const read = {
      url: "https://a.example/",
      title: "A",
      text: fenced("t"),
      truncated: false,
      background: false,
      selection: null,
      language: null,
    };
    expect(response("agent-read", read).valid).toBe(true);
    expect(response("agent-read", { ...read, text: 1 }).errors).toEqual([
      "result.text must be a string",
    ]);
  });

  test("agent-open's tab is a string, and a page comes only with a list or why there is none", () => {
    expect(response("agent-open", { tab: 13 }).errors).toEqual(["result.tab must be a string"]);
    expect(response("agent-open", { tab: "13", title: "A" }).errors).toEqual([
      "result.url and result.title come only with result.elements or result.unlisted",
    ]);
  });

  test("agent-close answers closed: true", () => {
    expect(response("agent-close", { closed: false }).errors).toEqual([
      "result.closed must be true",
    ]);
  });

  test("a load error is one of the codes Vimma names", () => {
    const open = (loadError: unknown) => ({
      tab: "1",
      url: "https://a.example/",
      title: "A",
      unlisted: "error",
      loadError,
    });
    expect(response("agent-open", open("dnsNotFound")).valid).toBe(true);
    // An array holding a code would pass a check that let Object.hasOwn coerce it.
    for (const code of ["notACode", "toString", 1, ["dnsNotFound"]]) {
      expect(response("agent-open", open(code)).valid).toBe(false);
    }
  });

  test("repeated and reset labels are each a label: one good label does not carry a bad one", () => {
    expect(
      response("agent-elements", {
        url: "https://a.example/",
        title: "A",
        elements: fenced("e"),
        dropped: 0,
        repeated: ["a", "zz"],
      }).valid,
    ).toBe(false);
    const fill = { url: "https://a.example/", title: "A", loading: false, navigated: false };
    expect(response("agent-fill", { ...fill, filled: 1, reset: ["a"] }).valid).toBe(true);
    expect(response("agent-fill", { ...fill, filled: 1, reset: ["a", "zz"] }).valid).toBe(false);
  });

  describe("agent-activate", () => {
    const result = { url: "https://a.example/", title: "A", loading: false, navigated: false };

    test("url and title are strings, loading and navigated flags", () => {
      expect(response("agent-activate", result).valid).toBe(true);
      expect(response("agent-activate", { ...result, url: 1 }).errors).toEqual([
        "result.url must be a string",
      ]);
      expect(response("agent-activate", { ...result, navigated: "no" }).errors).toEqual([
        "result.navigated must be a boolean",
      ]);
    });

    test("a dialog is an object", () => {
      expect(response("agent-activate", { ...result, dialog: "alert" }).errors).toEqual([
        "result.dialog must be an object",
      ]);
    });

    test("a blocked submission names a host as a string, never an array holding one", () => {
      expect(response("agent-activate", { ...result, blocked: "a.example" }).valid).toBe(true);
      expect(response("agent-activate", { ...result, blocked: ["a.example"] }).valid).toBe(false);
    });

    test("stopped names the one reason there is", () => {
      expect(response("agent-activate", { ...result, stopped: "x" }).errors).toEqual([
        "result.stopped must be in-use",
      ]);
    });
  });

  describe("agent-screenshot", () => {
    const shot = (extra: Record<string, unknown>) => ({
      url: "https://a.example/",
      title: "A",
      mimeType: "image/png",
      data: "AAAA",
      width: 1,
      height: 1,
      ...extra,
    });

    test("url and title are strings", () => {
      expect(response("agent-screenshot", shot({})).valid).toBe(true);
      expect(response("agent-screenshot", shot({ url: 1 })).errors).toEqual([
        "result.url must be a string",
      ]);
    });

    test("data is a base64 string of at most AGENT_SCREENSHOT.base64 characters", () => {
      const cap = AGENT_SCREENSHOT.base64;
      expect(cap % 4).toBe(0);
      expect(response("agent-screenshot", shot({ data: "A".repeat(cap) })).valid).toBe(true);
      expect(response("agent-screenshot", shot({ data: "A".repeat(cap + 4) })).valid).toBe(false);
      expect(response("agent-screenshot", shot({ data: ["AAAA"] })).valid).toBe(false);
    });
  });
});

describe("responses and errors", () => {
  test("ok: false carries an error and no result", () => {
    const error = { code: "failed", message: "no" };
    expect(valid({ type: "response", id: 1, ok: false, error })).toBe(true);
    expect(errorsOf({ type: "response", id: 1, ok: false, error, result: {} })).toEqual([
      "ok: false needs error and no result",
    ]);
  });

  test("an unknown error code is named with the list of known ones", () => {
    const [error] = errorsOf({
      type: "response",
      id: 1,
      ok: false,
      error: { code: "nope", message: "no" },
    });
    expect(error).toMatch(/^error\.code must be one of bad-request, unauthorized, /);
  });

  test("retryAfter is refused on a code other than denied, whatever its reason", () => {
    const error = { code: "failed", message: "no", reason: "busy", retryAfter: 5 };
    expect(errorsOf({ type: "response", id: 1, ok: false, error })).toEqual([
      "error.reason is only for denied",
      "error.retryAfter is only for a busy denial",
    ]);
  });

  test("a chat question that is not an object is named as such", () => {
    const state = {
      mode: "normal",
      pending: null,
      workspace: null,
      tabs: [],
      panes: null,
      chat: { view: "chat", rows: 0, entries: 0, question: "y" },
    };
    expect(response("state", state).errors).toEqual([
      "result.chat.question must be an object or null",
    ]);
  });
});

describe("validateMessage: what is not a message is never valid", () => {
  test.each([null, "hello", 1, [], true])("%j", (message) => {
    expect(validateMessage(message)).toEqual({
      valid: false,
      errors: ["message must be a JSON object"],
    });
  });

  test("an unknown kind is never valid", () => {
    // @ts-expect-error -- a kind outside the list, as a caller's typo would pass
    expect(validateMessage({ type: "hello" }, { kind: "hullo" }).valid).toBe(false);
  });

  test.each([
    ["bye", 'unknown message type "bye"'],
    [7, "unknown message type 7"],
    [null, "unknown message type null"],
    [undefined, "unknown message type undefined"],
    [["hello"], "unknown message type (an array)"],
    [{ toString: 1 }, "unknown message type (an object)"],
  ])("type %j is named without calling anything on it", (type, error) => {
    expect(errorsOf({ type })).toEqual([error]);
  });
});

describe("LineFramer and tokensEqual (S4, S5)", () => {
  test("after an overflow the framer holds no bytes", () => {
    const framer = new LineFramer(4);
    framer.push(new TextEncoder().encode("ab"));
    expect(framer.push(new TextEncoder().encode("cdefgh\n"))).toEqual([]);
    expect(framer.overflow).toBe(true);
    expect(framer.chunks).toEqual([]);
    expect(framer.length).toBe(0);
  });

  test("two empty strings are not equal tokens", () => {
    expect(tokensEqual("", "")).toBe(false);
  });

  test("tokensEqual reads every character, wherever two tokens differ", () => {
    const spy = vi.spyOn(String.prototype, "charCodeAt");
    try {
      const calls = (a: string, b: string) => {
        spy.mockClear();
        tokensEqual(a, b);
        return spy.mock.calls.length;
      };
      const other = `f${TOKEN.slice(1)}`;
      expect(other).toHaveLength(64);
      expect(other[0]).not.toBe(TOKEN[0]);
      expect(calls(TOKEN, TOKEN)).toBe(128);
      expect(calls(TOKEN, other)).toBe(128);
      expect(calls(TOKEN, `${TOKEN.slice(0, 63)}f`)).toBe(128);
    } finally {
      spy.mockRestore();
    }
  });

  test("only strings are tokens, even an object that reads like one", () => {
    const lookalike = { length: 1, charCodeAt: () => 0x78 };
    // @ts-expect-error -- not a string, as an in-process caller could pass
    expect(tokensEqual(lookalike, "x")).toBe(false);
    // @ts-expect-error -- not a string, as an in-process caller could pass
    expect(tokensEqual("x", lookalike)).toBe(false);
  });
});

// The mutation run of issue #1119 after #1319: each test below fails against one surviving mutant.
describe("arguments and fields no command names are refused (S7)", () => {
  // "Stryker was here" is the one name an allow-list mutated to ["Stryker was here"] would let
  // through, so it stands beside ordinary names.
  test.each(["state", "reload-theme", "agent-tabs", "agent-ping"])(
    "%s takes no argument, whatever its name",
    (command) => {
      expect(valid(req(command))).toBe(true);
      for (const name of ["x", "tab", "Stryker was here"]) {
        expect(errorsOf(req(command, { [name]: 1 }))).toEqual([`unknown field "args.${name}"`]);
      }
    },
  );

  test("agent-activate's result has no field beyond its own", () => {
    const result = { url: "https://a.example/", title: "A", loading: false, navigated: false };
    expect(response("agent-activate", result).valid).toBe(true);
    for (const name of ["filled", "Stryker was here"]) {
      expect(response("agent-activate", { ...result, [name]: 1 }).errors).toEqual([
        `unknown field "result.${name}"`,
      ]);
    }
  });
});

describe("agent-bookmarklet's name (bookmarklets B12)", () => {
  // Astral characters, so the limit is counted in code points, not UTF-16 code units.
  const run = (name: string) => req("agent-bookmarklet", { tab: "1", name });

  test("a name of exactly 1024 code points is taken; 1025 are not", () => {
    expect(valid(run("\u{1d49c}".repeat(1024)))).toBe(true);
    expect(
      parseAgentRequest("agent-bookmarklet", { tab: "1", name: "\u{1d49c}".repeat(1024) }),
    ).not.toBeNull();
    expect(errorsOf(run("\u{1d49c}".repeat(1025)))).toEqual([
      "name must be a string of 1 to 1024 characters",
    ]);
  });
});

describe("parseAgentRequest: only a plain object is a command's arguments", () => {
  test("a function is refused, even one JSON would copy into good arguments", () => {
    const args = Object.assign(() => undefined, { toJSON: () => ({ tab: "1" }) });
    expect(JSON.parse(JSON.stringify(args))).toEqual({ tab: "1" });
    expect(parseAgentRequest("agent-close", { tab: "1" })).not.toBeNull();
    expect(parseAgentRequest("agent-close", args)).toBeNull();
  });

  test("arguments JSON cannot copy are refused", () => {
    expect(parseAgentRequest("agent-close", { tab: "1", big: 1n })).toBeNull();
    const cycle: Record<string, unknown> = { tab: "1" };
    cycle.self = cycle;
    expect(parseAgentRequest("agent-close", cycle)).toBeNull();
  });
});

describe("LineFramer and tokensEqual: what is held and what is read (S4, S5)", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  test("a push that ends on a line end holds no partial line", () => {
    const framer = new LineFramer(16);
    expect(framer.push(bytes("ab\n"))).toEqual([bytes("ab")]);
    expect(framer.chunks).toEqual([]);
    expect(framer.length).toBe(0);
  });

  test("an empty push holds nothing and completes nothing", () => {
    const framer = new LineFramer(16);
    expect(framer.push(new Uint8Array(0))).toEqual([]);
    expect(framer.chunks).toEqual([]);
  });

  test("tokensEqual reads as many characters as the longer token has", () => {
    const spy = vi.spyOn(String.prototype, "charCodeAt");
    try {
      const calls = (a: string, b: string) => {
        spy.mockClear();
        expect(tokensEqual(a, b)).toBe(false);
        return spy.mock.calls.length;
      };
      expect(calls(TOKEN, TOKEN.slice(0, 63))).toBe(128);
      expect(calls(TOKEN.slice(0, 1), TOKEN)).toBe(128);
    } finally {
      spy.mockRestore();
    }
  });
});
