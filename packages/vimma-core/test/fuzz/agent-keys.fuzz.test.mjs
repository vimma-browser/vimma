// Fuzzing `vimma_keys`'s parser (docs/specs/mcp-drive.md D9, security.md M16): the keys come from
// an agent, which a page can steer, so any text must parse to whitelisted actions within the
// limits, or be refused; never a throw, never another action id.
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { AGENT_KEY_ACTIONS, AGENT_KEY_LIMITS, parseAgentKeys } from "../../src/agent-keys.mjs";
import { FUZZ_TIMEOUT, PROTO_NAMES, fuzz, nastyString, within } from "./harness.mjs";

/** Pieces of key notation, refused keys among them, so random joins often parse. */
const piece = fc.oneof(
  { weight: 2, arbitrary: nastyString },
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      ..."jkhldugGHLnN/?:txivyypPfFr]w[q0123456789 ",
      "gg",
      "f",
      "fa",
      "fsd",
      "fasdfghjkl",
      "3f",
      "gu",
      "gU",
      "gi",
      "gt",
      "<CR>",
      "<cr>",
      "<C-d>",
      "<C-w>",
      "<C-^>",
      "<Esc>",
      "<leader>",
      "<",
      ">",
      "ctrl+b",
      "prefix+x",
      "ctrl+shift+i",
      "esc",
      "\t",
    ),
  },
  { weight: 1, arbitrary: fc.constantFrom(...PROTO_NAMES) },
);
const keys = fc.array(piece, { maxLength: 40 }).map((parts) => parts.join(""));

describe("vimma_keys parser fuzzing", () => {
  test(
    "any text parses to whitelisted actions within the limits, or is refused",
    () =>
      fuzz(
        "agent-keys-whitelist",
        fc.property(fc.oneof(keys, nastyString), (text) => {
          within(1000, () => {
            const r = parseAgentKeys(text);
            if (!r.ok) {
              expect(typeof r.error).toBe("string");
              return;
            }
            expect([...text].length).toBeLessThanOrEqual(AGENT_KEY_LIMITS.chars);
            expect(r.steps.length).toBeGreaterThan(0);
            expect(r.steps.length).toBeLessThanOrEqual(AGENT_KEY_LIMITS.actions);
            for (const step of r.steps) {
              expect(AGENT_KEY_ACTIONS.has(step.action)).toBe(true);
              expect(step.count ?? 1).toBeLessThanOrEqual(AGENT_KEY_LIMITS.count);
              if (step.label !== undefined) {
                expect(step.action).toBe("hint.follow");
                expect(step.label).toMatch(/^[asdfghjkl]{1,3}$/);
              }
              if (step.action === "hint.follow" && step.label === undefined) {
                expect(step).toBe(r.steps.at(-1));
              }
              if (step.query !== undefined) {
                expect([...step.query].length).toBeLessThanOrEqual(AGENT_KEY_LIMITS.query);
                expect(step.query).not.toMatch(/\p{Cc}/u);
              }
            }
          });
        }),
      ),
    FUZZ_TIMEOUT,
  );
});
