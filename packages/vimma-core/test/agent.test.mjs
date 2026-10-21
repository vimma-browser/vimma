// docs/specs/vimma-mcp.md, sub-PR 1: the agent workspace's commands (`:mcp on|off|forget`),
// their questions, and its picker row.
import { describe, test, expect } from "vitest";
import {
  AGENT_GLYPH,
  MCP_FORGET_QUESTION,
  mcpOnQuestion,
  mcpStatus,
  parseMcpCommand,
  planMcpSwitch,
} from "../src/agent.mjs";
import { workspaceItems } from "../src/picker.mjs";
import { parseCommandLine as parseCommand } from "../src/cmdline.mjs";
import { ACTIONS, getAction } from "../src/actions.mjs";
import { compileKeymap } from "../src/keymap.mjs";

describe(":mcp words", () => {
  test("nothing is the status; on, off and forget in any case; anything else is refused", () => {
    expect(parseMcpCommand(undefined)).toEqual({ kind: "status" });
    expect(parseMcpCommand("  ")).toEqual({ kind: "status" });
    expect(parseMcpCommand("on")).toEqual({ kind: "on" });
    expect(parseMcpCommand(" OFF ")).toEqual({ kind: "off" });
    expect(parseMcpCommand("forget")).toEqual({ kind: "forget" });
    expect(parseMcpCommand("revoke")).toEqual({ kind: "revoke" });
    // docs/specs/mcp-drive.md D14: the last 100 agent calls.
    expect(parseMcpCommand("log")).toEqual({ kind: "log" });
    expect(parseMcpCommand("maybe")).toEqual({
      kind: "refuse",
      text: ":mcp takes on, off, revoke, forget or log",
    });
  });
});

describe(":mcp on|off (decision 26: config wins; the question only for the command)", () => {
  test("on asks first; off sets at once; the same state says so", () => {
    expect(planMcpSwitch("on", { pref: false })).toEqual({ kind: "ask" });
    expect(planMcpSwitch("off", { pref: true })).toEqual({
      kind: "set",
      value: false,
      text: "mcp off: agents cannot reach Vimma",
    });
    expect(planMcpSwitch("on", { pref: true })).toEqual({ kind: "say", text: "mcp is already on" });
    expect(planMcpSwitch("off", { pref: false })).toEqual({
      kind: "say",
      text: "mcp is already off",
    });
  });

  test("with [mcp] enabled in config.toml, :mcp on|off changes nothing and says to edit it", () => {
    for (const word of /** @type {const} */ (["on", "off"])) {
      for (const config of [true, false]) {
        expect(planMcpSwitch(word, { pref: false, config })).toEqual({
          kind: "say",
          text: `mcp: config.toml sets [mcp] enabled = ${config}; change it there`,
        });
      }
    }
  });

  test("the question names the workspace; an adopted one of your own is warned about", () => {
    expect(mcpOnQuestion("agent", null)).toBe(
      'Let local AI agents ask to use the "agent" workspace? Every request asks you first. y/N',
    );
    expect(mcpOnQuestion("agent", { tabs: 3 })).toBe(
      '"agent" is your own workspace (3 tabs, its own logins). Agents will be able to read it. y/N',
    );
    expect(mcpOnQuestion("bots", { tabs: 1 })).toBe(
      '"bots" is your own workspace (1 tab, its own logins). Agents will be able to read it. y/N',
    );
  });

  test(":mcp forget asks before the agent's cookies and site data go", () => {
    expect(MCP_FORGET_QUESTION).toBe(
      "Delete the agent workspace's cookies and site data (its logins)? y/N",
    );
  });

  test("the status says on or off, where that comes from, and the workspace", () => {
    expect(mcpStatus({ enabled: false, from: "pref", workspace: "agent" })).toBe(
      'mcp off · agent workspace "agent" · :mcp on lets agents ask to use it',
    );
    expect(mcpStatus({ enabled: true, from: "pref", workspace: "agent" })).toBe(
      'mcp on · agent workspace "agent" · every request asks you first',
    );
    expect(mcpStatus({ enabled: true, from: "config", workspace: "bots" })).toBe(
      'mcp on (config.toml) · agent workspace "bots" · every request asks you first',
    );
  });
});

describe("the agent workspace's picker row (decision 9)", () => {
  const model = {
    active: "w1",
    workspaces: [
      { id: "w1", name: "main", tabs: ["t1"], activeTab: "t1" },
      { id: "w2", name: "agent", tabs: ["t2", "t3", "t4"], activeTab: "t2" },
    ],
  };

  test("its row reads ◇ agent, keeps its place and is marked; the others are as before", () => {
    const items = workspaceItems(/** @type {any} */ (model), () => false, "w2");
    expect(items[1]).toEqual({
      kind: "workspace",
      workspaceId: "w2",
      workspaceName: "agent",
      workspaceIndex: 2,
      tabCount: 3,
      foreignCount: 0,
      display: `${AGENT_GLYPH} agent`,
      active: false,
      agent: true,
    });
    expect(AGENT_GLYPH).toBe("◇");
    expect(items[0]).toEqual(workspaceItems(/** @type {any} */ (model))[0]);
    expect(workspaceItems(/** @type {any} */ (model))[1]?.display).toBe("agent");
  });
});

describe(":mcp and its action (group Agents, no default key)", () => {
  test(":mcp runs mcp.command, with its word as text", () => {
    expect(parseCommand(":mcp")).toMatchObject({ kind: "run", action: { id: "mcp.command" } });
    expect(parseCommand(":mcp on")).toMatchObject({
      kind: "run",
      command: "mcp",
      action: { id: "mcp.command" },
      text: "on",
    });
    expect(parseCommand(":mcp forget")).toMatchObject({ text: "forget" });
  });

  test("mcp_command is in the Agents group and unbound", () => {
    expect(getAction("mcp_command")).toMatchObject({ id: "mcp.command", group: "Agents" });
    // agent_prompt (prefix+shift+a) and control_command (:control) share the group.
    expect(ACTIONS.filter((a) => a.group === "Agents").map((a) => a.name)).toEqual([
      "mcp_command",
      "agent_prompt",
      "control_command",
    ]);
    expect(compileKeymap().bindingsFor("mcp_command")).toEqual([]);
  });
});
