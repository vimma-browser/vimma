// Edges of the agent CLI's words and streams that the weekly mutation run (#1119) found unpinned:
// an own tool's line for an input with no JSON form, an exit's blank error lines, counts that are
// not finite numbers, the stream after a fail and after its end, and each CLI's events that look
// like another's. docs/specs/builtin-agent-cli.md C8, Behaviour 9 and 13; docs/security/ M56;
// the main suite is agent-cli.test.ts.
import { describe, expect, test } from "vitest";
import {
  CLI_STREAM_LIMITS,
  CLIS,
  CODEX_SERVER,
  ClaudeStream,
  CodexStream,
  GeminiStream,
  exitText,
  ownToolText,
} from "../src/agent/agent-cli.mjs";

const CLAUDE = CLIS["claude-code"];
if (!CLAUDE) throw new Error("no CLI claude-code");
const jsonl = (lines: unknown[]) => lines.map((l) => `${JSON.stringify(l)}\n`).join("");

describe("the window's words at their edges (Behaviour 9, 13)", () => {
  test("an own tool's input with no JSON form leaves no trailing space or placeholder", () => {
    // JSON.stringify gives undefined for a value whose toJSON does.
    const input = { toJSON: () => undefined };
    expect(ownToolText(CLAUDE, "Bash", input)).toBe("claude-code ran its own tool: Bash");
  });

  test("an exit names the last error line with text, past blank ones", () => {
    expect(exitText(CLAUDE, 1, "the real error\n   \n\t\n")).toBe(
      "claude-code exited (1): the real error",
    );
  });
});

describe("claude-code's stream at its edges (C8)", () => {
  test("counts that are not finite numbers count as none", () => {
    // 1e999 is valid JSON that parses to Infinity; a string is not a count.
    const s = new ClaudeStream();
    const out = s.push(
      '{"type":"result","is_error":false,"usage":{"input_tokens":1e999,' +
        '"output_tokens":"7"},"total_cost_usd":1e999}\n' +
        '{"type":"result","is_error":false,"total_cost_usd":"0.5","queued_turn_count":"2"}\n',
    );
    expect(out).toEqual([
      { type: "result", ok: true, error: null, usage: null, rest: null, cost: null, queued: 0 },
      { type: "result", ok: true, error: null, usage: null, rest: null, cost: null, queued: 0 },
    ]);
  });

  test("a result it cannot read before any init names no version", () => {
    const s = new ClaudeStream();
    expect(s.push('{"type":"result","is_error":"no"}\n')).toEqual([
      { type: "fail", error: "claude-code speaks a stream Vimma does not read" },
    ]);
  });

  test("a system event that is not a refusal is ignored, whatever ids it carries", () => {
    const s = new ClaudeStream();
    const out = s.push(
      jsonl([{ type: "system", subtype: "api_retry", tool_use_id: "u1", tool_name: "Bash" }]),
    );
    expect(out).toEqual([]);
    expect(s.ignored).toBe(1);
  });
});

describe("a stream after a fail and after its end (C8)", () => {
  const other = {
    type: "item.completed",
    item: { id: "m1", type: "mcp_tool_call", server: "elsewhere" },
  };
  const reply = { type: "item.completed", item: { id: "r1", type: "agent_message", text: "hi" } };
  const failed = {
    type: "fail",
    error: "codex called an MCP server that is not Vimma's: elsewhere",
  };

  test("lines after a fail in the same chunk are not read", () => {
    const s = new CodexStream();
    expect(s.push(jsonl([other, reply]))).toEqual([failed]);
  });

  test("a partial line left after a fail is not read at the end", () => {
    const s = new CodexStream();
    expect(s.push(`${JSON.stringify(other)}\n${JSON.stringify(reply)}`)).toEqual([failed]);
    expect(s.end()).toEqual([]);
  });

  test("white space the end left unread still counts toward the next line's limit", () => {
    const s = new ClaudeStream();
    s.push("  ");
    expect(s.end()).toEqual([]);
    expect(s.push(`${"x".repeat(CLI_STREAM_LIMITS.line - 1)}\n`)).toEqual([
      { type: "fail", error: "claude-code wrote a line over 1 MiB" },
    ]);
  });

  test("the end reads the last line once", () => {
    const s = new ClaudeStream();
    expect(s.push('{"type":"telemetry"}')).toEqual([]);
    expect(s.end()).toEqual([]);
    expect(s.ignored).toBe(1);
    expect(s.end()).toEqual([]);
    expect(s.ignored).toBe(1);
  });
});

describe("codex's stream at its edges (C8)", () => {
  test("without a model the init names codex's own default as empty", () => {
    for (const s of [new CodexStream(), new CodexStream({})]) {
      expect(s.push('{"type":"thread.started"}\n')).toEqual([
        { type: "init", model: "", version: "", tools: null },
      ]);
    }
  });

  test("each own-tool item without an id is shown", () => {
    const item = { type: "command_execution", command: "ls" };
    const s = new CodexStream();
    const out = s.push(
      jsonl([
        { type: "item.started", item },
        { type: "item.completed", item },
      ]),
    );
    const text = 'codex ran its own tool: shell "ls"';
    expect(out).toEqual([
      { type: "own-tool", id: "", text },
      { type: "own-tool", id: "", text },
    ]);
  });

  test("vimma's own calls are still skipped", () => {
    const s = new CodexStream();
    const call = { type: "item.completed", item: { type: "mcp_tool_call", server: CODEX_SERVER } };
    expect(s.push(jsonl([call]))).toEqual([]);
  });
});

describe("gemini's stream at its edges (C8, M56)", () => {
  test("without a model the init names gemini's own default as empty", () => {
    for (const s of [new GeminiStream(), new GeminiStream({})]) {
      expect(s.push('{"type":"init"}\n')).toEqual([
        { type: "init", model: "", version: "", tools: null },
      ]);
    }
  });

  test("an assistant's content on an event that is not a message is not the reply", () => {
    const s = new GeminiStream();
    const out = s.push(
      jsonl([
        { type: "note", role: "assistant", content: "not a reply" },
        { type: "result", status: "success" },
      ]),
    );
    expect(out).toEqual([
      { type: "result", ok: true, error: null, usage: null, rest: null, cost: null, queued: 0 },
    ]);
    expect(s.ignored).toBe(1);
  });

  test("an unknown event is ignored and counted", () => {
    const s = new GeminiStream();
    expect(s.push(jsonl([{ type: "telemetry" }, { type: "warning", message: "w" }]))).toEqual([]);
    expect(s.ignored).toBe(2);
  });

  test("an error event without a text message is no run error", () => {
    const s = new GeminiStream();
    expect(s.push(jsonl([{ type: "error", message: 42 }]))).toEqual([]);
    expect(s.end()).toEqual([]);
  });

  test("a run ended by its last error gives one result, however often it ends", () => {
    const s = new GeminiStream();
    s.push(jsonl([{ type: "error", message: "quota" }]));
    expect(s.end()).toEqual([
      { type: "result", ok: false, error: "quota", usage: null, rest: null, cost: null, queued: 0 },
    ]);
    expect(s.end()).toEqual([]);
  });

  test("own tools without ids are each shown, never read as one id given twice", () => {
    const s = new GeminiStream();
    const use = { type: "tool_use", tool_name: "read_file", parameters: { file_path: "a" } };
    const text = 'gemini ran its own tool: read_file "a"';
    expect(s.push(jsonl([use, use]))).toEqual([
      { type: "own-tool", id: "", text },
      { type: "own-tool", id: "", text },
    ]);
  });
});
