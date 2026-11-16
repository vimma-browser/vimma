// Issue #1163: a name the model, a page, the CLI or a socket client chose is looked up in Vimma's
// tables as an own key only, so "toString", "constructor" and "__proto__" never reach an
// inherited property of the table (docs/security/12-agents-mcp.md: values from an agent are data).
import { describe, expect, test } from "vitest";
import { fillRefusal, parseFillTarget } from "../src/agent/agent-act.mjs";
import { chatKey } from "../src/agent/agent-chat.mjs";
import { CLIS, ownToolText } from "../src/agent/agent-cli.mjs";
import { checkToolCall } from "../src/agent/agent-loop.mjs";
import { agentAlertText } from "../src/agent/agent-prompt.mjs";
import { toolCommand } from "../src/agent/agent-results.mjs";

const INHERITED = ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"];

describe("own keys only (#1163)", () => {
  test.each(INHERITED)("toolCommand: %j is no agent tool", (name) => {
    expect(toolCommand(name, {})).toBe(null);
  });

  test("toolCommand: a __proto__ argument from the model stays an own key, never the prototype", () => {
    const args = JSON.parse('{"tab":"1","__proto__":{"evil":true}}');
    const r = toolCommand("vimma_tabs", args);
    if (!r) throw new Error("vimma_tabs is an agent tool");
    expect(r.command).toBe("agent-tabs");
    expect(Object.getPrototypeOf(r.args)).toBe(Object.prototype);
    expect(Object.hasOwn(r.args, "__proto__")).toBe(true);
    expect(Object.keys(r.args)).toEqual(["tab", "__proto__"]);
    expect(r.args.evil).toBe(undefined);
  });

  const strict = [
    {
      name: "t",
      description: "",
      inputSchema: {
        type: "object",
        properties: { a: { type: "string" } },
        additionalProperties: false,
      },
    },
  ];
  test.each(INHERITED)("checkToolCall: an extra %j argument is refused", (name) => {
    const args = JSON.parse(`{"a":"x",${JSON.stringify(name)}:1}`);
    expect(checkToolCall({ id: "x", name: "t", args }, strict)).toBe(
      `t takes no ${JSON.stringify(name)}`,
    );
  });

  test.each(INHERITED)(
    "checkToolCall: a required argument is not met by an inherited %j",
    (name) => {
      const tools = [
        {
          name: "t",
          description: "",
          inputSchema: { type: "object", properties: { [name]: {} }, required: [name] },
        },
      ];
      expect(checkToolCall({ id: "x", name: "t", args: {} }, tools)).toBe(
        `t needs ${JSON.stringify(name)}`,
      );
    },
  );

  test.each(INHERITED)("ownToolText: a CLI tool %j shows its whole input", (name) => {
    const cli = CLIS["claude-code"];
    if (!cli) throw new Error("no claude-code");
    // The property name an inherited table value turns into when it is used as a key.
    const input = { [String(({} as Record<string, unknown>)[name])]: "x" };
    expect(ownToolText(cli, name, input).endsWith(' "x"')).toBe(false);
  });

  test.each(INHERITED)("parseFillTarget: a secret %j is refused", (secret) => {
    const box = { alive: true, kind: "field", field: "text", secret };
    expect(parseFillTarget(box)).toBe(null);
  });

  test.each(INHERITED)("fillRefusal: a secret %j still refuses, in plain words", (secret) => {
    const why = fillRefusal("sf", { alive: true, kind: "field", field: "text", secret }, "x");
    expect(why).toBe(
      'field "sf" is a sensitive field; Vimma never fills it: ask the user to type it',
    );
  });

  test.each(INHERITED)("chatKey: %j does nothing", (key) => {
    expect(chatKey("", key)).toEqual({ kind: "none" });
  });

  test.each(INHERITED)("agentAlertText: a tool %j is asked as a tool", (tool) => {
    expect(agentAlertText({ tool, label: { client: "c" }, what: {} } as never)).toBe(
      "c asks to use Vimma's agent workspace (use a tool)",
    );
  });
});
