// Fuzzing the control protocol (control.mjs): the server's line framing and the validator every
// message passes before the server acts on it. Any local process can connect, so everything
// before the handshake is hostile. Spec: docs/specs/m7-fuzzing.md.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  AGENT_COMMANDS,
  CONTROL_COMMANDS,
  DENY_REASONS,
  ERROR_CODES,
  LineFramer,
  RESERVED_COMMANDS,
  tokensEqual,
  validateMessage,
} from "../../src/control.mjs";
import { parseKey } from "../../src/keys.mjs";
import { MODES } from "../../src/modes.mjs";
import { FUZZ_TIMEOUT, PROTO_NAMES, fuzz, nastyString, within } from "./harness.mjs";

const FIELDS = [
  "type",
  "id",
  "command",
  "args",
  "ok",
  "result",
  "error",
  "protocol",
  "nonce",
  "role",
  "roles",
  "reason",
  "tab",
  "url",
  "client",
];
const KINDS = ["hello", "challenge", "auth", "welcome", "request", "response", "discovery"];
const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);
const id = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
const tabId = fc.integer({ min: 1, max: 2 ** 40 }).map(String);
const chord = fc.constantFrom("a", "ctrl+b", "G", "esc", "shift+tab", "<", "minus", "ctrl+plus");
const url = fc.oneof(
  fc.webUrl(),
  fc.constantFrom("about:blank", "file:///etc/hosts", "HTTPS://A.COM/", "about:vimma#bug"),
);

/** Valid messages of every kind, each with the options its check needs. */
const validMessage = fc.oneof(
  hex64.map((nonce) => ({ m: { type: "hello", protocol: 1, nonce }, o: {} })),
  hex64.map((proof) => ({ m: { type: "challenge", protocol: 1, proof }, o: {} })),
  hex64.map((token) => ({ m: { type: "auth", token }, o: {} })),
  fc
    .tuple(fc.string(), fc.string())
    .map(([app, version]) => ({ m: { type: "welcome", protocol: 1, app, version }, o: {} })),
  fc.tuple(id, fc.array(chord, { minLength: 1, maxLength: 256 })).map(([i, keys]) => ({
    m: { type: "request", id: i, command: "send-keys", args: { keys: keys.join(" ") } },
    o: {},
  })),
  fc
    .tuple(id, url, fc.option(fc.constantFrom("tab", "current"), { nil: undefined }))
    .map(([i, u, where]) => ({
      m: {
        type: "request",
        id: i,
        command: "open",
        args: where === undefined ? { url: u } : { url: u, where },
      },
      o: {},
    })),
  fc
    .tuple(id, fc.constantFrom("state", "reload-theme", ...RESERVED_COMMANDS))
    .map(([i, command]) => ({ m: { type: "request", id: i, command, args: {} }, o: {} })),
  fc
    .tuple(
      fc.option(id, { nil: null }),
      fc.constantFrom(...ERROR_CODES),
      fc.string(),
      fc.constantFrom(...DENY_REASONS),
    )
    .map(([i, code, message, reason]) => ({
      m: {
        type: "response",
        id: i,
        ok: false,
        // Protocol 2: a denial says why, and only a denial carries a reason.
        error: code === "denied" ? { code, message, reason } : { code, message },
      },
      o: {},
    })),
  // Protocol 2 (docs/specs/vimma-mcp.md): roles, the agent commands and their results.
  fc.tuple(hex64, fc.constantFrom("agent", "full")).map(([nonce, role]) => ({
    m: { type: "hello", protocol: 2, nonce, role },
    o: {},
  })),
  fc.constantFrom("agent", "full").map((role) => ({
    m: { type: "welcome", protocol: 2, app: "Vimma", version: "1", role },
    o: {},
  })),
  fc
    .tuple(hex64, fc.constantFrom(["agent"], ["full"], ["agent", "full"]))
    .map(([token, roles]) => ({
      m: { protocol: 2, port: 4000, token, pid: 7, roles },
      o: { kind: "discovery" },
    })),
  fc
    .tuple(id, tabId, fc.constantFrom("markdown", "text"), fc.integer({ min: 1, max: 500000 }))
    .map(([i, tab, format, max]) => ({
      m: { type: "request", id: i, command: "agent-read", args: { tab, format, max_chars: max } },
      o: {},
    })),
  fc.tuple(id, fc.webUrl(), fc.option(tabId, { nil: undefined })).map(([i, u, tab]) => ({
    m: {
      type: "request",
      id: i,
      command: "agent-open",
      args: tab === undefined ? { url: u } : { url: u, tab },
    },
    o: {},
  })),
  fc.tuple(id, tabId).map(([i, tab]) => ({
    m: { type: "request", id: i, command: "agent-close", args: { tab } },
    o: {},
  })),
  fc.tuple(id, fc.constantFrom("agent-tabs", "agent-ping")).map(([i, command]) => ({
    m: { type: "request", id: i, command, args: {} },
    o: {},
  })),
  fc.tuple(id, fc.constantFrom("example-agent", "codex", "opencode")).map(([i, name]) => ({
    m: { type: "request", id: i, command: "agent-hello", args: { client: { name } } },
    o: {},
  })),
  fc
    .array(fc.record({ id: tabId, url: fc.string(), title: fc.string(), loading: fc.boolean() }), {
      maxLength: 3,
    })
    .map((tabs) => ({
      m: { type: "response", id: 1, ok: true, result: { tabs } },
      o: { command: "agent-tabs" },
    })),
  fc.tuple(fc.string(), fc.boolean()).map(([text, truncated]) => ({
    m: {
      type: "response",
      id: 1,
      ok: true,
      result: {
        url: "https://a/",
        title: "A",
        text,
        truncated,
        selection: null,
        language: "en",
        background: true,
      },
    },
    o: { command: "agent-read" },
  })),
  fc.tuple(id, fc.nat()).map(([i, sent]) => ({
    m: { type: "response", id: i, ok: true, result: { sent } },
    o: { command: "send-keys" },
  })),
  fc
    .tuple(
      fc.constantFrom(...MODES),
      fc.array(
        fc.record({
          id: fc.string(),
          url: fc.string(),
          title: fc.string(),
          selected: fc.constant(false),
        }),
        { maxLength: 3 },
      ),
      // Every split of the workspace (multiple-splits): optional, as from an older Vimma.
      fc.option(
        fc.array(
          fc.record({
            number: fc.integer({ min: 1, max: 9 }),
            shown: fc.boolean(),
            focus: fc.string(),
            zoomed: fc.boolean(),
            root: fc.constant({}),
          }),
          { maxLength: 3 },
        ),
        { nil: undefined },
      ),
    )
    .map(([mode, tabs, splits]) => ({
      m: {
        type: "response",
        id: 1,
        ok: true,
        result: {
          mode,
          pending: null,
          workspace: "w",
          tabs,
          panes: null,
          ...(splits ? { splits } : {}),
        },
      },
      o: { command: "state" },
    })),
  fc.tuple(fc.integer({ min: 1, max: 65535 }), hex64, id).map(([port, token, pid]) => ({
    m: { protocol: 1, port, token, pid },
    o: { kind: "discovery" },
  })),
);

/** Values that are not what a field holds: wrong types, edge numbers, prototype names. */
const wrongValue = fc.oneof(
  fc.constantFrom(null, true, 0, -1, 1.5, 2 ** 53, Number.NaN, "", [], {}, "1", "x".repeat(65)),
  fc.constantFrom(...PROTO_NAMES),
  nastyString,
  fc.jsonValue({ maxDepth: 2 }),
  // Objects whose keys shadow Object's members, as JSON.parse makes them: {"toString": 0}.
  fc
    .tuple(fc.constantFrom(...PROTO_NAMES), fc.constantFrom(0, "x", null, [], {}))
    .map(([k, v]) => JSON.parse(`{${JSON.stringify(k)}:${JSON.stringify(v)}}`)),
);

/** @param {unknown} v */
const jsonType = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/** Fields that take more than one JSON type: `string | null`, `integer | null`, anything. */
const UNION_FIELDS = ["pending", "workspace", "panes", "selection", "language"];

describe("control protocol fuzzing", () => {
  test(
    "LineFramer gives back the lines sent, however the bytes are chunked",
    () =>
      fuzz(
        "control-framing",
        fc.property(
          fc.array(
            fc.tuple(
              fc.uint8Array({ maxLength: 40 }).map((a) => a.map((b) => (b === 0x0a ? 0x20 : b))),
              fc.constantFrom("\n", "\r\n"),
            ),
            { maxLength: 8 },
          ),
          fc.uint8Array({ maxLength: 40 }).map((a) => a.filter((b) => b !== 0x0a)),
          fc.array(fc.nat(), { maxLength: 10 }),
          (lines, tail, cuts) => {
            const MAX = 32;
            const enc = (/** @type {string} */ s) => new TextEncoder().encode(s);
            const stream = new Uint8Array(
              [...lines.flatMap(([l, end]) => [...l, ...enc(end)]), ...tail].map(Number),
            );
            // The model: each line loses one \r before its \n; the first one over MAX ends it.
            /** @type {number[][]} */
            const want = [];
            let overflow = false;
            for (const [l, end] of lines) {
              let got = [...l, ...(end === "\r\n" ? [0x0d] : [])];
              if (got.at(-1) === 0x0d) got = got.slice(0, -1);
              if (got.length > MAX) {
                overflow = true;
                break;
              }
              want.push(got);
            }
            if (!overflow && tail.length > MAX + 1) overflow = true;

            const framer = new LineFramer(MAX);
            const bounds = [...new Set(cuts.map((c) => c % (stream.length + 1)))].sort(
              (a, b) => a - b,
            );
            /** @type {number[][]} */
            const have = [];
            let from = 0;
            for (const to of [...bounds, stream.length]) {
              for (const line of framer.push(stream.subarray(from, to))) have.push([...line]);
              expect(framer.length).toBeLessThanOrEqual(MAX + 1);
              from = Math.max(from, to);
            }
            expect(have).toEqual(want);
            expect(framer.overflow).toBe(overflow);
          },
        ),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "any line a client sends, decoded as the server does, validates without throwing",
    () =>
      fuzz(
        "control-any-line",
        fc.property(
          fc.oneof(
            fc.uint8Array({ maxLength: 200 }),
            fc.json({ maxDepth: 3 }).map((s) => new TextEncoder().encode(s)),
            validMessage.map(({ m }) => new TextEncoder().encode(JSON.stringify(m))),
            // Protocol field names with values of any shape, `type` included.
            fc
              .dictionary(
                fc.constantFrom(...FIELDS, ...PROTO_NAMES),
                fc.oneof(
                  wrongValue,
                  fc.constantFrom(...KINDS, ...CONTROL_COMMANDS, ...AGENT_COMMANDS),
                  fc.dictionary(fc.constantFrom(...FIELDS, ...PROTO_NAMES), wrongValue),
                ),
              )
              .map((o) => new TextEncoder().encode(JSON.stringify(o))),
          ),
          fc.option(fc.constantFrom(...KINDS, ...PROTO_NAMES), { nil: undefined }),
          fc.option(fc.constantFrom(...CONTROL_COMMANDS, ...AGENT_COMMANDS, ...PROTO_NAMES), {
            nil: undefined,
          }),
          (bytes, kind, command) => {
            let message;
            try {
              message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            } catch {
              message = undefined;
            }
            const v = within(1000, () =>
              validateMessage(message, /** @type {any} */ ({ kind, command })),
            );
            expect(v.valid).toBe(v.errors.length === 0);
            for (const e of v.errors) expect(typeof e).toBe("string");
          },
        ),
        { weight: 20 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "every valid message validates; one changed or added field makes it invalid",
    () =>
      fuzz(
        "control-schema",
        fc.property(
          validMessage,
          fc.nat(),
          wrongValue,
          fc.oneof(fc.constantFrom(...PROTO_NAMES), nastyString),
          fc.boolean(),
          ({ m, o }, pick, value, extra, add) => {
            expect(validateMessage(m, o).errors).toEqual([]);
            const copy = structuredClone(m);
            // Mutate the envelope, or an object one level down (args, error, result).
            const targets = [
              copy,
              ...Object.values(copy).filter((v) => v && typeof v === "object" && !Array.isArray(v)),
            ];
            const target = /** @type {Record<string, unknown>} */ (targets[pick % targets.length]);
            const keys = Object.keys(target);
            if (add || keys.length === 0) {
              if (Object.hasOwn(target, extra)) return;
              // Server-to-client messages and results ignore unknown fields by design (spec
              // m0-control-protocol-and-vimma-ctl); requests and response envelopes are strict.
              const kind = o.kind ?? /** @type {any} */ (m).type;
              if (["welcome", "challenge", "discovery"].includes(kind)) return;
              if (target === /** @type {any} */ (copy).result) return;
              // Reserved commands are answered not-implemented before their args are read.
              if (
                target === /** @type {any} */ (copy).args &&
                RESERVED_COMMANDS.includes(/** @type {any} */ (copy).command)
              )
                return;
              // An own property even for "__proto__", as JSON.parse makes it.
              Object.defineProperty(target, extra, {
                value,
                enumerable: true,
                writable: true,
                configurable: true,
              });
            } else {
              const key = /** @type {string} */ (keys[pick % keys.length]);
              // A value of another JSON type: always outside the schema, but for union fields.
              if (jsonType(target[key]) === jsonType(value) || UNION_FIELDS.includes(key)) return;
              if (key === "id" && value === null && copy.type === "response") return;
              target[key] = value;
            }
            expect(validateMessage(copy, o).valid, JSON.stringify(copy)).toBe(false);
          },
        ),
        { weight: 20 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "send-keys passes only keys the server can parse; open only short http(s), file and about URLs",
    () =>
      fuzz(
        "control-args",
        fc.property(
          fc.oneof(
            fc
              .array(fc.oneof(chord, nastyString, fc.constantFrom(...PROTO_NAMES)), {
                maxLength: 6,
              })
              .map((k) => k.join(" ")),
            nastyString,
          ),
          fc.oneof(
            url,
            nastyString,
            fc.constantFrom(
              "javascript:alert(1)",
              "data:,x",
              "JaVaScRiPt:x",
              " http://a",
              "view-source:http://a",
              "http:\u0000//a",
            ),
          ),
          (keys, u) => {
            const sk = validateMessage({
              type: "request",
              id: 1,
              command: "send-keys",
              args: { keys },
            });
            if (sk.valid) {
              // The server maps every chord through parseKey after validation (VimmaControl).
              for (const c of keys.split(/\s+/).filter(Boolean))
                expect(() => parseKey(c)).not.toThrow();
            }
            const op = validateMessage({
              type: "request",
              id: 1,
              command: "open",
              args: { url: u },
            });
            if (op.valid) {
              expect(u.length).toBeLessThanOrEqual(65536);
              expect([...u].some((c) => c <= " " || c === "\x7f")).toBe(false);
              expect(u).toMatch(/^(?:https?|file|about):/i);
            }
          },
        ),
        { weight: 20 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "agent-open passes only short http(s) URLs; agent labels never carry control or bidi characters",
    () =>
      fuzz(
        "control-agent-args",
        fc.property(
          fc.oneof(
            url,
            nastyString,
            fc.constantFrom(
              "javascript:alert(1)",
              "data:,x",
              "file:///etc/passwd",
              "https://a/\u0000",
            ),
          ),
          fc.oneof(
            nastyString,
            fc.string({ maxLength: 70 }),
            fc.constantFrom("a\u202eb", "a\u2066"),
          ),
          fc.oneof(nastyString, fc.constantFrom("1", "01", "12", "-3", "1e2")),
          (u, label, tab) => {
            const op = validateMessage({
              type: "request",
              id: 1,
              command: "agent-open",
              args: { url: u },
            });
            if (op.valid) {
              expect(u.length).toBeLessThanOrEqual(65536);
              expect([...u].some((c) => c <= " " || c === "\x7f")).toBe(false);
              expect(u).toMatch(/^https?:/i);
            }
            const hi = validateMessage({
              type: "request",
              id: 1,
              command: "agent-hello",
              args: { client: { name: label } },
            });
            if (hi.valid) {
              expect([...label].length).toBeLessThanOrEqual(64);
              for (const c of label) {
                const cp = /** @type {number} */ (c.codePointAt(0));
                const bad =
                  cp <= 0x1f ||
                  (cp >= 0x7f && cp <= 0x9f) ||
                  (cp >= 0x202a && cp <= 0x202e) ||
                  (cp >= 0x2066 && cp <= 0x2069);
                expect(bad, `U+${cp.toString(16)}`).toBe(false);
              }
            }
            const close = validateMessage({
              type: "request",
              id: 1,
              command: "agent-close",
              args: { tab },
            });
            if (close.valid) expect(tab).toMatch(/^[1-9][0-9]*$/);
          },
        ),
        { weight: 20 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "tokensEqual is string equality of non-empty tokens",
    () =>
      fuzz(
        "control-tokens",
        fc.property(
          fc.oneof(hex64, nastyString),
          fc.oneof(hex64, nastyString),
          fc.boolean(),
          (a, b, twin) => {
            const other = twin ? a : b;
            expect(tokensEqual(a, other)).toBe(a === other && a.length > 0);
          },
        ),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "a 1 MiB line of any shape validates in bounded time",
    () => {
      const mib = 1024 * 1024;
      const req = (/** @type {object} */ args, command = "send-keys") => ({
        type: "request",
        id: 1,
        command,
        args,
      });
      for (const m of [
        req({ keys: "a ".repeat(mib / 2) }),
        req({ keys: " ".repeat(mib) }),
        req({ keys: "ctrl+".repeat(mib / 5) + "a" }),
        req({ keys: "<".repeat(mib) }),
        req({ url: `https://${"a".repeat(mib)}` }, "open"),
        req({ url: "\u0000".repeat(mib) }, "open"),
        {
          type: "response",
          id: 1,
          ok: true,
          result: { mode: "normal", tabs: Array(mib / 16).fill({}), panes: null },
        },
        Object.fromEntries(Array.from({ length: mib / 16 }, (_, i) => [`k${i}`, i])),
      ]) {
        within(5000, () => validateMessage(m, { command: "state" }));
      }
    },
    FUZZ_TIMEOUT,
  );
});
