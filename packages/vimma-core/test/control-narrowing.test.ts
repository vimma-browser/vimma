// parseAgentRequest reads each argument again after the validator passed it, "so a shape the
// checks let through by mistake is refused here rather than handed on" (control.mjs). With the
// shipped agent-act no such shape gets through, so these tests make agent-act's checks loose on
// purpose: a hoisted mock lets isAgentLabel take the number 7 and adds 7 to ELEMENT_KINDS. What
// then reaches a handler is still a string label and string kinds (docs/security/12-agents-mcp.md;
// the mutation run of issue #1119).
import { describe, test, expect, vi } from "vitest";
import { parseAgentRequest, validateMessage } from "../src/control/control.mjs";

vi.mock("../src/agent/agent-act.mjs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/agent/agent-act.mjs")>();
  return {
    ...real,
    isAgentLabel: (v: unknown) => v === 7 || real.isAgentLabel(v),
    ELEMENT_KINDS: Object.freeze([...real.ELEMENT_KINDS, 7]),
  };
});

const passes = (command: string, args: Record<string, unknown>) =>
  validateMessage({ type: "request", id: 1, command, args }).valid;
const fill = (extra: Record<string, unknown>) => ({
  tab: "1",
  fields: [{ label: "a", value: "x" }],
  ...extra,
});

describe("parseAgentRequest hands on only the shapes its handlers read", () => {
  test("an activate's label that is no string is refused", () => {
    const args = { tab: "1", label: 7 };
    expect(passes("agent-activate", args)).toBe(true);
    expect(parseAgentRequest("agent-activate", args)).toBeNull();
    expect(parseAgentRequest("agent-activate", { tab: "1", label: "a" })?.args).toStrictEqual({
      tab: "1",
      label: "a",
    });
  });

  test("a fill whose field's label is no string is refused", () => {
    const args = fill({ fields: [{ label: 7, value: "x" }] });
    expect(passes("agent-fill", args)).toBe(true);
    expect(parseAgentRequest("agent-fill", args)).toBeNull();
  });

  test("a fill whose submit is neither true nor a string is refused", () => {
    const args = fill({ submit: 7 });
    expect(passes("agent-fill", args)).toBe(true);
    expect(parseAgentRequest("agent-fill", args)).toBeNull();
    expect(parseAgentRequest("agent-fill", fill({ submit: "s" }))?.args).toStrictEqual(
      fill({ submit: "s" }),
    );
  });

  test("kinds that are not all strings are not handed on", () => {
    const args = { tab: "1", kinds: ["link", 7] };
    expect(passes("agent-elements", args)).toBe(true);
    expect(parseAgentRequest("agent-elements", args)?.args).toStrictEqual({ tab: "1" });
    expect(parseAgentRequest("agent-elements", { tab: "1", kinds: ["link"] })?.args).toStrictEqual({
      tab: "1",
      kinds: ["link"],
    });
  });
});
