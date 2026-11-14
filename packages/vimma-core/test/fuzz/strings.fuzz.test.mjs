// Fuzzing the linear-time string edits (strings.mjs) that replaced regular expressions CodeQL
// flagged as polynomial (js/polynomial-redos): each must agree with the expression it replaced on
// any input, and stay fast on the long runs that made the expression slow.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { deleteWordBackward, trimBlanks, trimTrailing } from "../../src/text/strings.mjs";
import { redactReport } from "../../src/ui/report.mjs";
import { FUZZ_TIMEOUT, fuzz, nastyString, within } from "./harness.mjs";

/** Strings rich in the characters the old expressions backtracked on. */
const runs = fc
  .array(
    fc.oneof(
      fc.constantFrom(" ", "\t", "/", "\n", " ", "　", "a", "x.", "-", "_", "é", "\ud800"),
      nastyString,
    ),
    { maxLength: 30 },
  )
  .map((parts) => parts.join(""));

/** A long run of `c` with a breaker on either side, the shape that made the old ones slow. */
const longRun = fc
  .tuple(
    fc.constantFrom(" ", "\t", "/", "\n"),
    fc.integer({ min: 50_000, max: 200_000 }),
    fc.string({ maxLength: 3 }),
    fc.string({ maxLength: 3 }),
  )
  .map(([c, n, before, after]) => `${before}${c.repeat(n)}${after}x`);

/** report.mjs before the fix: the oracle for small inputs. */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S*?(?=[\s,;)\]]|[.,;:!?]?(?:\s|$))/gi;
/** @param {string} text @param {string} home */
function oldRedact(text, home) {
  let out = text.replace(URL_RE, "<url>");
  const h = home.replace(/\/+$/, "");
  const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (h) out = out.replace(new RegExp(`${esc}(?=/|\\b|$)(?![\\w.-])`, "g"), "~");
  return out;
}

describe("linear-time string edits", () => {
  test(
    "each agrees with the regular expression it replaced",
    () =>
      fuzz(
        "strings-oracle",
        fc.property(runs, (s) => {
          expect(trimBlanks(s)).toBe(s.replace(/^[ \t]+|[ \t]+$/g, ""));
          expect(trimTrailing(s, "/")).toBe(s.replace(/\/+$/, ""));
          expect(deleteWordBackward(s)).toBe(s.replace(/\S*\s*$/, ""));
        }),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "redactReport redacts exactly what the regular expression did",
    () =>
      fuzz(
        "strings-redact-oracle",
        fc.property(
          fc.oneof(runs, fc.constantFrom("/home/alice", "/home/al.ice/", "/h-1/", "/x/é", "/a+b")),
          fc.array(
            fc.oneof(runs, fc.constantFrom("/home/alice", "/home/alicebob", "/home/al.ice", "~")),
            { maxLength: 6 },
          ),
          (home, parts) => {
            const text = parts.join(parts.length % 2 ? "/" : " ");
            expect(redactReport(text, home)).toBe(oldRedact(text, home));
            expect(redactReport(`${home}/x ${home}`, home)).toBe(
              oldRedact(`${home}/x ${home}`, home),
            );
          },
        ),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "each runs in bounded time on long runs of one character",
    () =>
      fuzz(
        "strings-bounded",
        fc.property(longRun, (s) => {
          within(500, () => {
            trimBlanks(s);
            trimTrailing(s, "/");
            deleteWordBackward(s);
            redactReport("/home/alice/x", s);
            redactReport(s, "/home/alice");
          });
        }),
        { weight: 0.2 },
      ),
    FUZZ_TIMEOUT,
  );
});
