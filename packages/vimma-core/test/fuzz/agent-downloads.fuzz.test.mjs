// Fuzzing the agent downloads' checks (docs/specs/vimma-mcp.md, decision 31 d): the file is the
// page's choice, so the zip lister and the magic-byte check must take any bytes without a throw
// or a hang, and a listing never points outside the file.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  ZIP_TAIL_BYTES,
  clamVerdict,
  dangerousContent,
  dangerousName,
  zipEntryList,
  zipLocate,
  zipVerdict,
} from "../../src/agent/agent-downloads.mjs";
import { makeZip } from "../agent-downloads.test.mjs";
import { FUZZ_TIMEOUT, fuzz, nastyString, within } from "./harness.mjs";

/** A zip's bytes, then some of them changed at random. */
const mangledZip = fc
  .tuple(
    fc.array(fc.oneof(nastyString, fc.constantFrom("a.sh", "b.pdf", "c/d.so")), { maxLength: 6 }),
    fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 8 }),
    fc.boolean(),
  )
  .map(([names, flips, cut]) => {
    const zip = makeZip(names);
    for (const [at, v] of flips) zip[at % zip.length] = v;
    return cut ? zip.subarray(0, Math.max(0, zip.length - 7)) : zip;
  });

const anyBytes = fc.oneof(fc.uint8Array({ maxLength: 512 }), mangledZip);

describe("agent downloads fuzzing", () => {
  test(
    "any bytes: the zip lister and the magic check never throw, and stay inside the file",
    () =>
      fuzz(
        "agent-download-bytes",
        fc.property(anyBytes, (bytes) => {
          within(500, () => {
            dangerousContent(bytes);
            const tail = bytes.subarray(Math.max(0, bytes.length - ZIP_TAIL_BYTES));
            const at = zipLocate(tail, bytes.length);
            if (at.kind !== "zip") return;
            expect(at.offset).toBeGreaterThanOrEqual(0);
            expect(at.offset + at.length).toBeLessThanOrEqual(bytes.length);
            const names = zipEntryList(
              bytes.subarray(at.offset, at.offset + at.length),
              at.entries,
            );
            if (names) {
              expect(names.length).toBeLessThanOrEqual(at.entries);
              zipVerdict(names);
            }
          });
        }),
        { weight: 10 },
      ),
    FUZZ_TIMEOUT,
  );

  test(
    "any name and any ClamAV output: an answer, never a throw",
    () =>
      fuzz(
        "agent-download-text",
        fc.property(nastyString, fc.integer({ min: -3, max: 300 }), (s, code) => {
          dangerousName(s);
          const v = clamVerdict({ exitCode: code, stdout: s });
          expect(["clean", "infected", "error"]).toContain(v.kind);
        }),
      ),
    FUZZ_TIMEOUT,
  );
});
