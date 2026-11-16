// Fuzzing the linear-time string edits (strings.mjs) that replaced regular expressions CodeQL
// flagged as polynomial (js/polynomial-redos): each must agree with the expression it replaced on
// any input, and stay fast on the long runs that made the expression slow.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { deleteWordBackward, trimBlanks, trimTrailing } from "../../src/text/strings.mjs";
import { redactReport } from "../../src/ui/report.mjs";
import { FUZZ_TIMEOUT, fuzz, nastyString, within } from "./harness.ts";

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

/**
 * The oracle for small inputs, a brute-force reading of the rule (#1173) rather than the scan
 * redactReport does: after URLs become `<url>`, walk the text code point by code point and, at
 * each one, try every slice that starts there; a slice is the home when its NFD form is the
 * home's (trailing slashes dropped), and what follows it ends a name: the end, whitespace, `/`,
 * `\\`, a path delimiter, or `.`, `!` or `?` closing a sentence. A redacted slice is skipped whole.
 */
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S*?(?=[\s,;)\]]|[.,;:!?]?(?:\s|$))/gi;
const ENDS_NAME = /^(?:$|[\s/\\:;,"'`()[\]{}<>]|[.!?](?:\s|$))/u;
function oracleRedact(text: string, home: string): string {
  const cps = [...text.replace(URL_RE, "<url>")];
  const h = home.replace(/\/+$/, "").normalize("NFD");
  if (!h) return cps.join("");
  let out = "";
  let i = 0;
  while (i < cps.length) {
    let end = -1;
    for (let j = i + 1; j <= cps.length && end === -1; j++) {
      const rest = cps.slice(j).join("");
      if (cps.slice(i, j).join("").normalize("NFD") === h && ENDS_NAME.test(rest)) end = j;
    }
    if (end === -1) {
      out += cps[i];
      i += 1;
    } else {
      out += "~";
      i = end;
    }
  }
  return out;
}

/** Characters that sit on either side of the rule: name characters, delimiters, both forms. */
const nameParts = fc.constantFrom(
  "+",
  "\u{1F600}",
  "\u200D",
  "\u203F",
  "~",
  ":",
  '"',
  "(",
  "]",
  ",",
  ".",
  "?",
  "\\",
  "\u00E9",
  "e\u0301",
  "\u0301",
  "\u0316",
  "\u037E",
  "\u212A",
  "\uD55C",
  "\u1112\u1161\u11AB",
);

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
    "redactReport redacts exactly what the brute-force rule does",
    () =>
      fuzz(
        "strings-redact-oracle",
        fc.property(
          fc.oneof(
            runs,
            fc.constantFrom("/home/alice", "/home/al.ice/", "/h-1/", "/x/é", "/a+b", "/jose\u0301"),
            fc
              .array(fc.oneof(nameParts, fc.constantFrom("/h", "a")), {
                minLength: 1,
                maxLength: 4,
              })
              .map((p) => `/${p.join("")}`),
          ),
          fc.array(
            fc.oneof(
              runs,
              nameParts,
              fc.constantFrom("/home/alice", "/home/alicebob", "/home/al.ice", "~", "/jos\u00E9"),
            ),
            { maxLength: 6 },
          ),
          (home, parts) => {
            const text = parts.join(parts.length % 2 ? "/" : " ");
            expect(redactReport(text, home)).toBe(oracleRedact(text, home));
            for (const t of [
              `${home}/x ${home}`,
              `${home.normalize("NFC")}: ${home.normalize("NFD")}`,
            ]) {
              expect(redactReport(t, home)).toBe(oracleRedact(t, home));
            }
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
