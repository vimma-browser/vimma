// docs/specs/bookmarklets.md B12-B16 (security.md M63): an agent asks to run one of the user's
// bookmarklets by its title. The command takes a tab and a title, never script; the question
// is asked every time with y and n only; the result says it ran and nothing of the script's.
import { describe, test, expect } from "vitest";
import { AGENT_COMMANDS, parseAgentRequest, validateMessage } from "../src/control/control.mjs";
import { AGENT_TOOLS, ALWAYS_ASK, BOOKMARKLET_RATE } from "../src/agent/agent.mjs";
import { TOOL_COMMANDS, toolResult } from "../src/agent/agent-results.mjs";
import {
  BOOKMARKLET_TOOL,
  agentAlertText,
  noGrant,
  promptKey,
  questionLine,
  stepText,
} from "../src/agent/agent-prompt.mjs";

const req = (args: Record<string, unknown>) => ({
  type: "request",
  id: 1,
  command: "agent-bookmarklet",
  args,
});
const errorsOf = (message: unknown, command?: string) =>
  validateMessage(message, command ? { command } : undefined).errors;
const text = (line: { parts: { text: string }[] }) => line.parts.map((p) => p.text).join("");

describe("agent-bookmarklet in the protocol (B12)", () => {
  test("is an agent command and the tool vimma_bookmarklet", () => {
    expect(AGENT_COMMANDS).toContain("agent-bookmarklet");
    expect(AGENT_TOOLS).toMatchObject({ "agent-bookmarklet": "vimma_bookmarklet" });
    expect(TOOL_COMMANDS).toMatchObject({ vimma_bookmarklet: "agent-bookmarklet" });
    expect(BOOKMARKLET_TOOL).toBe("vimma_bookmarklet");
  });

  test("takes a tab and a title, and nothing else: no url, no script", () => {
    expect(errorsOf(req({ tab: "12", name: "Readability" }))).toEqual([]);
    expect(parseAgentRequest("agent-bookmarklet", { tab: "12", name: "Readability" })).toEqual({
      command: "agent-bookmarklet",
      args: { tab: "12", name: "Readability" },
    });
    expect(errorsOf(req({ tab: "12" }))).toEqual(["name must be a string of 1 to 1024 characters"]);
    expect(errorsOf(req({ tab: "12", name: "" }))).toEqual([
      "name must be a string of 1 to 1024 characters",
    ]);
    expect(errorsOf(req({ tab: "12", name: "x".repeat(1025) }))).toEqual([
      "name must be a string of 1 to 1024 characters",
    ]);
    expect(errorsOf(req({ name: "Readability" }))).toEqual(["tab must be a tab id (digits)"]);
    expect(errorsOf(req({ tab: "12", name: "R", url: "javascript:alert(1)" }))).toEqual([
      'unknown field "args.url"',
    ]);
    expect(errorsOf(req({ tab: "12", name: "R", script: "alert(1)" }))).toEqual([
      'unknown field "args.script"',
    ]);
    expect(parseAgentRequest("agent-bookmarklet", { tab: "12", name: 5 })).toBeNull();
  });

  test("its result is ran: true, and nothing else", () => {
    const ok = (result: unknown) => ({ type: "response", id: 1, ok: true, result });
    expect(errorsOf(ok({ ran: true }), "agent-bookmarklet")).toEqual([]);
    expect(errorsOf(ok({ ran: false }), "agent-bookmarklet")).toEqual(["result.ran must be true"]);
    expect(errorsOf(ok({ ran: true, value: "x" }), "agent-bookmarklet")).toEqual([
      'unknown field "result.value"',
    ]);
  });
});

describe("the gate asks every time (B14, B16)", () => {
  const q = {
    tool: "vimma_bookmarklet",
    label: { client: "claude-code" },
    what: {
      tab: "7",
      index: 2,
      title: "Pricing · Example",
      url: "https://example.com/pricing",
      bookmarklet: "toolbar/tools/Readability",
    },
  };

  test("no grant covers it and its answer makes none", () => {
    expect(ALWAYS_ASK).toContain("vimma_bookmarklet");
    expect(noGrant(q)).toBe(true);
    expect(promptKey({ count: "" }, "a", { noGrant: true })).toEqual({ kind: "ignore" });
    expect(promptKey({ count: "" }, "x", { noGrant: true })).toEqual({
      kind: "answer",
      answer: { kind: "deny" },
    });
  });

  test("the question names the bookmarklet and the page, and offers y and n", () => {
    const line = questionLine(q, { grantMinutes: 15 });
    expect(text(line)).toBe(
      '◇ claude-code wants vimma_bookmarklet: 2 "Pricing · Example" example.com/pricing' +
        '  run "toolbar/tools/Readability" (its code acts as this page)',
    );
    expect(line.hint).toBe("y run it · n deny");
    expect(agentAlertText(q)).toBe(
      "claude-code asks to use Vimma's agent workspace (run one of your bookmarklets)",
    );
  });

  test("the built-in agent's transcript says which bookmarklet ran where", () => {
    expect(stepText(q)).toBe(
      'ran the bookmarklet "toolbar/tools/Readability" in "Pricing · Example"',
    );
  });

  test("at most 6 a minute per connection", () => {
    expect(BOOKMARKLET_RATE).toEqual({ max: 6, ms: 60_000 });
  });
});

describe("the built-in agent reads the result (B16)", () => {
  test("it ran, in the background, and how to see what it did", () => {
    expect(
      toolResult("vimma_bookmarklet", { tab: "9", name: "Readability" }, { ran: true }),
    ).toEqual({
      content: [
        {
          type: "text",
          text:
            'Ran the bookmarklet "Readability" in tab 9 of Vimma\'s agent workspace, in the ' +
            "background. Read the page with vimma_read_page to see what it did.",
        },
      ],
    });
    expect(toolResult("vimma_bookmarklet", { tab: "9", name: "R" }, { ran: false })).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Vimma's answer broke the control protocol: Vimma's result does not say ran.",
        },
      ],
    });
  });
});
