// Fuzzing the agent role's gate (docs/specs/vimma-mcp.md, "Fuzzing, a11y and test norms"): page
// text is hostile, so the delimiters must hold for any text; and no sequence of requests,
// answers, timeouts and disconnects can break the queue's limits or let a request run twice.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  AgentQueue,
  QUEUE_LIMITS,
  UNTRUSTED_CLOSE,
  UNTRUSTED_OPEN,
  wrapUntrusted,
} from "../../src/agent.mjs";
import { FUZZ_TIMEOUT, fuzz, nastyString } from "./harness.mjs";

/** Occurrences of `needle` in `text`. @param {string} text @param {string} needle */
const count = (text, needle) => text.split(needle).length - 1;

const pieces = fc.oneof(
  nastyString,
  fc.constantFrom(
    UNTRUSTED_OPEN,
    UNTRUSTED_CLOSE,
    UNTRUSTED_CLOSE.toUpperCase(),
    "</untrusted-web-content",
    ">",
    "<",
    "/",
    "\u200b",
    // Look-alikes (security.md M7): spaced, separated otherwise, full-width, with attributes.
    "</untrusted-web-content >",
    "</ untrusted-web-content>",
    "<\n/untrusted-web-content\n>",
    "</untrusted\u2010web\u2011content>",
    "</ＵＮＴＲＵＳＴＥＤ_web_content>",
    "<untrusted-web-content x>",
  ),
  // Random separators between the words.
  fc
    .tuple(
      fc.constantFrom("", "/", " /", "/ "),
      fc.string({ maxLength: 6 }),
      fc.string({ maxLength: 6 }),
    )
    .map(
      ([slash, a, b]) =>
        `<${slash}untrusted${a.replaceAll(">", "")}content${b.replaceAll(">", "")}>`,
    ),
);
/** What a model might read as a delimiter (the rule wrapUntrusted applies). */
const LOOSE = /<\s*\/?\s*untrusted[^>]{0,40}content[^>]*>/gi;

describe("agent gate fuzzing", () => {
  test(
    "any page text comes out with exactly one opening and one closing delimiter",
    () =>
      fuzz(
        "agent-untrusted",
        fc.property(fc.array(pieces, { maxLength: 12 }), (parts) => {
          const out = wrapUntrusted(parts.join(""));
          const lower = out.toLowerCase();
          expect(count(lower, UNTRUSTED_OPEN)).toBe(1);
          expect(count(lower, UNTRUSTED_CLOSE)).toBe(1);
          // Only our own two delimiters still read as tags, after NFKC.
          expect(out.normalize("NFKC").match(LOOSE)).toHaveLength(2);
          expect(out.startsWith(`${UNTRUSTED_OPEN}\n`)).toBe(true);
          expect(out.endsWith(`\n${UNTRUSTED_CLOSE}`)).toBe(true);
        }),
        { weight: 20 },
      ),
    FUZZ_TIMEOUT,
  );

  // docs/specs/mcp-grants.md G2: whatever happens, a request asked with `always` (a submission,
  // a dangerous download) or vimma_show never runs under a grant, is resolved only by its own
  // answer, and an answer to it never makes a grant.
  test(
    "no sequence of events runs an always-ask request under a grant or makes a grant from one",
    () =>
      fuzz(
        "agent-queue-always",
        fc.property(
          fc.array(
            fc.oneof(
              fc.record({
                op: fc.constant("ask"),
                conn: fc.nat(3),
                tool: fc.constantFrom("a", "vimma_show"),
                always: fc.boolean(),
              }),
              fc.record({
                op: fc.constant("answer"),
                pick: fc.nat(),
                kind: fc.constantFrom("once", "deny", "grant"),
              }),
              fc.record({ op: fc.constant("revoke") }),
            ),
            { maxLength: 60 },
          ),
          (events) => {
            const q = new AgentQueue();
            for (let c = 0; c <= 3; c++) q.connect(c);
            /** @type {Set<number>} */
            const always = new Set();
            /** @type {Set<number>} conns that answered a grantable question with a grant */
            const granted = new Set();
            let now = 0;
            for (const e of events) {
              now += 1000;
              if (e.op === "ask") {
                const asked = e.always || e.tool === "vimma_show";
                const out = q.ask(e.conn, e.tool, now, { always: e.always });
                if (asked) expect(out.kind).not.toBe("run");
                if (asked && out.kind === "wait") always.add(out.id);
              } else if (e.op === "answer") {
                const waiting = q.waiting;
                if (!waiting.length) continue;
                const target = waiting[e.pick % waiting.length];
                const answer =
                  e.kind === "grant" ? { kind: "grant", minutes: 5 } : { kind: e.kind };
                const { resolved, grant } = q.answer(target.id, /** @type {any} */ (answer), now);
                for (const r of resolved) {
                  if (r.id !== target.id) expect(always.has(r.id)).toBe(false);
                }
                if (always.has(target.id)) expect(grant).toBeUndefined();
                else if (grant) granted.add(target.conn);
              } else {
                q.revoke(now);
                granted.clear();
              }
              for (const g of q.grants(now)) expect(granted.has(g.conn)).toBe(true);
            }
          },
        ),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "no sequence of events breaks the queue's limits or resolves a request twice",
    () =>
      fuzz(
        "agent-queue",
        fc.property(
          fc.array(
            fc.oneof(
              fc.record({
                op: fc.constant("ask"),
                conn: fc.nat(5),
                tool: fc.constantFrom("a", "b"),
              }),
              fc.record({
                op: fc.constant("answer"),
                pick: fc.nat(),
                kind: fc.constantFrom("once", "deny", "mute", "grant"),
                minutes: fc.integer({ min: -5, max: 2000 }),
              }),
              fc.record({ op: fc.constantFrom("expire", "cancel"), pick: fc.nat() }),
              fc.record({ op: fc.constantFrom("connect", "disconnect"), conn: fc.nat(5) }),
              fc.record({ op: fc.constant("revoke") }),
            ),
            { maxLength: 60 },
          ),
          (events) => {
            const q = new AgentQueue();
            const done = new Set();
            let now = 0;
            /** @param {{ id: number }[]} resolved */
            const settle = (resolved) => {
              for (const { id } of resolved) {
                expect(done.has(id)).toBe(false);
                done.add(id);
              }
            };
            for (const e of events) {
              now += 7000;
              const ids = q.waiting.map((r) => r.id);
              const target = ids.length ? ids[("pick" in e ? e.pick : 0) % ids.length] : -1;
              if (e.op === "ask") q.ask(e.conn, e.tool, now);
              else if (e.op === "answer") {
                const answer =
                  e.kind === "grant" ? { kind: "grant", minutes: e.minutes } : { kind: e.kind };
                settle(q.answer(target, /** @type {any} */ (answer), now).resolved);
              } else if (e.op === "expire") settle(q.expire(target, now).resolved);
              else if (e.op === "cancel") {
                if (q.cancel(target)) done.add(target);
              } else if (e.op === "connect") q.connect(e.conn);
              else if (e.op === "disconnect") for (const id of q.disconnect(e.conn)) done.add(id);
              else q.revoke();
              const waiting = q.waiting;
              expect(waiting.length).toBeLessThanOrEqual(QUEUE_LIMITS.total);
              for (let c = 0; c <= 5; c++) {
                expect(waiting.filter((r) => r.conn === c).length).toBeLessThanOrEqual(
                  QUEUE_LIMITS.perConnection,
                );
              }
              for (const r of waiting) expect(done.has(r.id)).toBe(false);
              for (const g of q.grants(now)) expect(g.until).toBeGreaterThan(now);
            }
          },
        ),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );
});
