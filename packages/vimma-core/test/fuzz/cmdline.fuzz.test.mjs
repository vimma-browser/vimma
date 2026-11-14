// Fuzzing the `:` command line (cmdline.mjs): text typed or pasted by the user, and add-on
// names from extensions for completion. Spec: docs/specs/m7-fuzzing.md.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  COMMANDS,
  completeCommandLine,
  createHistory,
  historyNext,
  historyPrevious,
  parseCommandLine,
  pushHistory,
} from "../../src/keys/cmdline.mjs";
import { ACTIONS } from "../../src/keys/actions.mjs";
import { FUZZ_TIMEOUT, PROTO_NAMES, fuzz, nastyString, within } from "./harness.mjs";

const IDS = new Set([
  ...ACTIONS.map((a) => a.id),
  ...COMMANDS.flatMap((c) => [c.action, c.textAction]),
]);
const WORDS = [...COMMANDS.flatMap((c) => [c.name, ...c.aliases]), ...ACTIONS.map((a) => a.name)];
const line = fc
  .tuple(
    fc.constantFrom("", ":", "::", " : "),
    fc.oneof(fc.constantFrom(...WORDS), fc.constantFrom(...PROTO_NAMES), nastyString),
    fc.constantFrom("", " ", "\t", "\n"),
    fc.oneof(
      fc.constant(""),
      nastyString,
      fc.constantFrom('"a b"', "'x'", "javascript:alert(1)", "data:,x"),
    ),
  )
  .map((parts) => parts.join(""));

describe("command line fuzzing", () => {
  test(
    "parseCommandLine never throws, and a run names a real action",
    () =>
      fuzz(
        "cmdline-parse",
        fc.property(fc.oneof(line, nastyString), (text) => {
          const r = within(1000, () => parseCommandLine(text));
          expect(["run", "empty", "error"]).toContain(r.kind);
          if (r.kind === "run") {
            expect(IDS.has(r.action.id), r.action.id).toBe(true);
            if (r.text !== undefined) expect(typeof r.text).toBe("string");
          }
          if (r.kind === "error") expect(Array.isArray(r.error.suggestions)).toBe(true);
        }),
        { weight: 20 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "completion never throws, for any line and any add-on names",
    () =>
      fuzz(
        "cmdline-complete",
        fc.property(
          fc.oneof(line, nastyString),
          fc.dictionary(
            fc.oneof(fc.constantFrom("addon", ...PROTO_NAMES), nastyString),
            fc.array(nastyString, { maxLength: 5 }),
          ),
          fc.nat({ max: 50 }),
          (text, args, limit) => {
            const r = within(1000, () => completeCommandLine(text, { limit, args }));
            expect(r.candidates.length).toBeLessThanOrEqual(limit);
            for (const c of r.candidates) expect(typeof c.value).toBe("string");
          },
        ),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "history keeps at most its limit, each line once, and browsing never throws",
    () =>
      fuzz(
        "cmdline-history",
        fc.property(
          fc.integer({ min: 1, max: 5 }),
          fc.array(fc.oneof(line, nastyString), { maxLength: 12 }),
          fc.array(fc.boolean(), { maxLength: 8 }),
          (limit, lines, moves) => {
            let h = createHistory({ limit });
            for (const l of lines) h = pushHistory(h, l);
            expect(h.entries.length).toBeLessThanOrEqual(limit);
            expect(new Set(h.entries).size).toBe(h.entries.length);
            let text = "";
            for (const up of moves)
              ({ history: h, text } = up ? historyPrevious(h, text) : historyNext(h, text));
            expect(typeof text).toBe("string");
          },
        ),
        { weight: 5 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "a pasted megabyte is parsed and completed in bounded time",
    () => {
      for (const text of [
        "x".repeat(1 << 20),
        `open ${"x".repeat(1 << 20)}`,
        `${":".repeat(1 << 20)}q`,
        " ".repeat(1 << 20),
      ]) {
        within(3000, () => parseCommandLine(text));
        within(3000, () => completeCommandLine(text));
      }
    },
    FUZZ_TIMEOUT,
  );
});
