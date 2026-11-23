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
  mcpState,
} from "../src/agent/agent.mjs";
import { workspaceItems } from "../src/ui/picker.mjs";
import { parseCommandLine as parseCommand } from "../src/keys/cmdline.mjs";
import { ACTIONS, getAction } from "../src/keys/actions.mjs";
import { compileKeymap } from "../src/keys/keymap.mjs";

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

describe(":mcp on|off (decision 26; setup-v2 decision 16: :mcp off wins over the file)", () => {
  test("on asks first; off turns agents off at once; the same state says so", () => {
    expect(planMcpSwitch("on", { pref: false, off: false })).toEqual({ kind: "ask" });
    expect(planMcpSwitch("off", { pref: true, off: false })).toEqual({
      kind: "off",
      pref: true,
      text: "mcp off: agents cannot reach Vimma",
    });
    expect(planMcpSwitch("on", { pref: true, off: false })).toEqual({
      kind: "say",
      text: "mcp is already on",
    });
    expect(planMcpSwitch("off", { pref: false, off: false })).toEqual({
      kind: "off",
      pref: false,
      text: "mcp is already off",
    });
  });

  test("with [mcp] enabled = true in config.toml, :mcp off turns agents off until restart", () => {
    expect(planMcpSwitch("off", { pref: false, config: true, off: false })).toEqual({
      kind: "off",
      pref: false,
      text:
        "mcp off until :mcp on or a restart; config.toml's [mcp] enabled = true turns agents " +
        "on again at the next start",
    });
    // The pref goes off too, so that taking the line out of the file later keeps agents off.
    expect(planMcpSwitch("off", { pref: true, config: true, off: true })).toEqual({
      kind: "off",
      pref: true,
      text: "mcp is already off",
    });
  });

  test(":mcp on after :mcp off asks again, whatever the file says", () => {
    expect(planMcpSwitch("on", { pref: false, config: true, off: true })).toEqual({ kind: "ask" });
    expect(planMcpSwitch("on", { pref: true, off: true })).toEqual({ kind: "ask" });
    expect(planMcpSwitch("on", { pref: false, config: true, off: false })).toEqual({
      kind: "say",
      text: "mcp is already on",
    });
  });

  test("with [mcp] enabled = false in config.toml, :mcp on changes nothing and says to edit it", () => {
    for (const off of [true, false]) {
      expect(planMcpSwitch("on", { pref: true, config: false, off })).toEqual({
        kind: "say",
        text: "mcp: config.toml sets [mcp] enabled = false; change it there",
      });
    }
    expect(planMcpSwitch("off", { pref: true, config: false, off: false })).toEqual({
      kind: "off",
      pref: true,
      text: "mcp is already off",
    });
  });

  test("the state: :mcp off first, then the file, then the pref", () => {
    expect(mcpState({ pref: true, off: false })).toEqual({ enabled: true, from: "pref" });
    expect(mcpState({ pref: false, config: true, off: false })).toEqual({
      enabled: true,
      from: "config",
    });
    expect(mcpState({ pref: true, config: false, off: false })).toEqual({
      enabled: false,
      from: "config",
    });
    expect(mcpState({ pref: false, config: true, off: true })).toEqual({
      enabled: false,
      from: "session",
    });
    expect(mcpState({ pref: true, off: true })).toEqual({ enabled: false, from: "session" });
    // Off either way: the file or the pref says why.
    expect(mcpState({ pref: false, config: false, off: true })).toEqual({
      enabled: false,
      from: "config",
    });
    expect(mcpState({ pref: false, off: true })).toEqual({ enabled: false, from: "pref" });
  });

  test("the question names the workspace; an adopted one of your own is warned about", () => {
    expect(mcpOnQuestion("agent", null)).toBe(
      'Let AI agents ask to use the "agent" workspace? Nothing runs until you allow it. y/N',
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
      'mcp on · agent workspace "agent" · nothing runs until you allow it',
    );
    expect(mcpStatus({ enabled: true, from: "config", workspace: "bots" })).toBe(
      'mcp on (config.toml) · agent workspace "bots" · nothing runs until you allow it',
    );
    expect(mcpStatus({ enabled: false, from: "session", workspace: "agent" })).toBe(
      'mcp off (until :mcp on or a restart) · agent workspace "agent" · :mcp on lets agents ask to use it',
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
    const items = workspaceItems(model as any, () => false, "w2");
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
    expect(items[0]).toEqual(workspaceItems(model as any)[0]);
    expect(workspaceItems(model as any)[1]?.display).toBe("agent");
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
    // agent_chat (prefix+i), agent_prompt (prefix+shift+a) and control_command (:control) share
    // the group.
    expect(ACTIONS.filter((a) => a.group === "Agents").map((a) => a.name)).toEqual([
      "agent_chat",
      "mcp_command",
      "agent_prompt",
      "control_command",
    ]);
    expect(compileKeymap().bindingsFor("mcp_command")).toEqual([]);
  });
});
