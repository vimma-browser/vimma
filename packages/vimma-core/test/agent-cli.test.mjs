// docs/specs/builtin-agent-cli.md C2, C4-C8, Behaviour 4-5, 9, 13: Claude Code run as a provider
// of the chat window. The streams in fixtures/agent-cli/ were recorded from Claude Code 2.1.303
// (`claude -p` with the arguments below) against a scripted Anthropic Messages server on
// 127.0.0.1, with a made-up key, a throwaway HOME and a one-tool MCP server named `vimma`; no
// real account was used and no tokens were spent. Temporary paths in them are replaced.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  CLI_STREAM_LIMITS,
  CLIS,
  ClaudeStream,
  claudeArguments,
  cliEnvironment,
  cliNotice,
  exitText,
  mcpConfig,
  ownToolText,
  ownToolsText,
  pathProblem,
  taskPrompt,
  userLine,
  versionText,
} from "../src/agent-cli.mjs";

/** @param {string} name */
const fixture = (name) =>
  readFileSync(new URL(`fixtures/agent-cli/${name}.jsonl`, import.meta.url), "utf8");

/** Every event of a whole stream, fed in chunks that cut lines in two. */
function events(/** @type {string} */ text, chunk = 97) {
  const s = new ClaudeStream();
  const out = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...s.push(text.slice(i, i + chunk)));
  out.push(...s.end());
  return { out, stream: s };
}

describe("claude-code's command line (C2)", () => {
  test("claude-code's arguments are the fixture, with the model only from the provider", () => {
    expect(claudeArguments({ mcpConfig: "/tmp/v/mcp.json", model: "" })).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--strict-mcp-config",
      "--mcp-config",
      "/tmp/v/mcp.json",
      "--allowedTools",
      "mcp__vimma",
      "--permission-mode",
      "dontAsk",
    ]);
    expect(claudeArguments({ mcpConfig: "/tmp/v/mcp.json", model: "sonnet" }).slice(-2)).toEqual([
      "--model",
      "sonnet",
    ]);
  });

  test("no argument removes or adds a cli's own tools", () => {
    const args = claudeArguments({ mcpConfig: "/m.json", model: "opus" });
    for (const flag of [
      "--tools",
      "--disallowedTools",
      "--dangerously-skip-permissions",
      "--bare",
      "--max-budget-usd",
      "--settings",
      "--add-dir",
    ]) {
      expect(args).not.toContain(flag);
    }
    // The one allow rule is Vimma's own server, so a headless run never waits on a prompt.
    expect(args.filter((a) => a.startsWith("mcp__"))).toEqual(["mcp__vimma"]);
  });

  test("the task is never an argument", () => {
    const task = '--dangerously-skip-permissions; rm -rf ~ "quoted" $(x)';
    const args = claudeArguments({ mcpConfig: "/m.json", model: "" });
    expect(args.join(" ")).not.toContain("rm -rf");
    const line = userLine(task);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({
      type: "user",
      message: { role: "user", content: task },
    });
  });

  test("a model that looks like an option is refused, not passed", () => {
    expect(() => claudeArguments({ mcpConfig: "/m.json", model: "--bare" })).toThrow(/model/);
  });

  test("the mcp configuration names only vimma-ctl, with the ticket in its environment", () => {
    const config = mcpConfig({
      vimmaCtl: "/opt/vimma/vimma-ctl",
      ticket: "ab".repeat(32),
      port: 4123,
    });
    expect(config).toEqual({
      mcpServers: {
        vimma: {
          type: "stdio",
          command: "/opt/vimma/vimma-ctl",
          args: ["mcp"],
          env: { VIMMA_AGENT_TICKET: "ab".repeat(32), VIMMA_AGENT_PORT: "4123" },
        },
      },
    });
  });

  test("the environment is Vimma's, minus the variables Vimma and Firefox set", () => {
    expect(
      cliEnvironment({
        HOME: "/home/u",
        PATH: "/usr/bin",
        MOZ_APP_LAUNCHER: "x",
        MOZ_CRASHREPORTER: "1",
        VIMMA_AGENT_TICKET: "stale",
        VIMMA_CTL: "x",
        ANTHROPIC_API_KEY: "kept: the CLI's login is its own",
      }),
    ).toEqual({
      HOME: "/home/u",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "kept: the CLI's login is its own",
    });
  });

  test("the version line names the version and the path", () => {
    expect(
      versionText(CLIS["claude-code"], "2.1.303 (Claude Code)\n", "/home/u/.local/bin/claude"),
    ).toBe("claude 2.1.303 · /home/u/.local/bin/claude");
    expect(versionText(CLIS["claude-code"], "\u001b[31mweird\n", "/usr/bin/claude")).toBe(
      "claude [31mweird · /usr/bin/claude",
    );
  });
});

describe("the conversation as one task (C5, Behaviour 12)", () => {
  test("the stored conversation goes before the new message, in one prompt", () => {
    const prompt = taskPrompt(
      [
        { role: "user", text: "Find the shop." },
        { role: "assistant", text: "It is at https://shop.example." },
        { role: "user", text: "(Vimma: an earlier task: done, 3 steps)" },
      ],
      "Add three items.",
    );
    expect(prompt).toContain("Find the shop.");
    expect(prompt).toContain("It is at https://shop.example.");
    expect(prompt.endsWith("Add three items.")).toBe(true);
    expect(taskPrompt([], "Only this.")).toBe("Only this.");
  });
});

describe("claude-code's stream (C7, C8)", () => {
  test("a recorded claude-code stream maps to replies, own-tool lines, usage and cost", () => {
    const { out, stream } = events(fixture("claude-code-2.1.303-task"));
    expect(out.map((e) => e.type)).toEqual([
      "init",
      "reply",
      "own-tool",
      "own-tool-refused",
      "reply",
      "result",
    ]);
    expect(out[0]).toMatchObject({ type: "init", model: "claude-sonnet-5-5", version: "2.1.303" });
    expect(out[1]).toEqual({ type: "reply", text: "Let me look at the tabs." });
    expect(out[2]).toEqual({
      type: "own-tool",
      id: "toolu_msg_fake_1_1",
      text: 'claude-code ran its own tool: Bash "ls ~/Downloads"',
    });
    expect(out[3]).toEqual({ type: "own-tool-refused", id: "toolu_msg_fake_1_1" });
    expect(out[5]).toEqual({
      type: "result",
      ok: true,
      error: null,
      usage: { input: 2400, output: 80 },
      cost: 0.0056,
      queued: 0,
    });
    expect(stream.ignored).toBeGreaterThan(0);
  });

  test("claude-code's init tools become the header's list, without mcp__vimma", () => {
    const [init] = events(fixture("claude-code-2.1.303-task")).out;
    const tools = /** @type {any} */ (init).tools;
    expect(tools).toContain("Bash");
    expect(tools).toContain("WebFetch");
    expect(tools.some((/** @type {string} */ t) => t.startsWith("mcp__"))).toBe(false);
    expect(ownToolsText(["Bash", "Read", "Write", "WebFetch", "Edit", "Glob", "Grep"])).toBe(
      "Bash, Read, Write, WebFetch +3",
    );
    expect(ownToolsText(["Bash"])).toBe("Bash");
    expect(ownToolsText([])).toBe("none");
  });

  test("a cli with no reported tool list states its configuration", () => {
    expect(ownToolsText(null)).toBe("as its configuration allows");
  });

  test("mcp__vimma tool calls in the stream are not transcript steps", () => {
    const { out } = events(fixture("claude-code-2.1.303-task"));
    const texts = out.map((e) => JSON.stringify(e));
    expect(texts.some((t) => t.includes("vimma_tabs"))).toBe(false);
  });

  test("a key the provider refuses ends in an error result, after the cli's retries", () => {
    const { out } = events(fixture("claude-code-2.1.303-bad-key"));
    // The retries are system events, and the synthetic reply that repeats the error is not
    // the agent's: the error shows once, as the task's end.
    expect(out.map((e) => e.type)).toEqual(["init", "result"]);
    expect(out[1]).toEqual({
      type: "result",
      ok: false,
      error: "Invalid API key · Fix external API key",
      usage: { input: 0, output: 0 },
      cost: 0,
      queued: 0,
    });
  });

  test("a result with queued turns says so, so the run's input stays open", () => {
    const init = fixture("claude-code-2.1.303-task").split("\n")[0];
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { input_tokens: 1, output_tokens: 2 },
      total_cost_usd: 0.01,
      queued_turn_count: 1,
    });
    expect(events(`${init}\n${result}\n`).out.at(-1)).toMatchObject({ type: "result", queued: 1 });
  });

  test("an init whose vimma server is not connected ends the run", () => {
    const init = fixture("claude-code-2.1.303-task")
      .split("\n")[0]
      .replace('"status":"connected"', '"status":"failed"');
    const { out } = events(`${init}\n`);
    expect(out).toEqual([{ type: "fail", error: "claude-code could not start vimma-ctl" }]);
  });

  test("an unknown event is ignored and counted", () => {
    const { out, stream } = events(
      '{"type":"telemetry","x":1}\n{"type":"system","subtype":"ui_invalidate"}\nnot json\n',
    );
    expect(out).toEqual([]);
    expect(stream.ignored).toBe(3);
  });

  test("a stream that no longer parses ends the run naming the version", () => {
    const init = fixture("claude-code-2.1.303-task").split("\n")[0];
    const { out } = events(`${init}\n{"type":"result","subtype":"success","usage":"many"}\n`);
    expect(out.at(-1)).toEqual({
      type: "fail",
      error: "claude-code 2.1.303 speaks a stream Vimma does not read",
    });
    const { out: noInit } = events('{"type":"system","subtype":"init","tools":7}\n');
    expect(noInit).toEqual([
      { type: "fail", error: "claude-code speaks a stream Vimma does not read" },
    ]);
  });

  test("a line over 1 MiB ends the run", () => {
    const s = new ClaudeStream();
    const big = "x".repeat(CLI_STREAM_LIMITS.line + 1);
    expect(s.push(big.slice(0, 600_000))).toEqual([]);
    expect(s.push(big.slice(600_000))).toEqual([
      { type: "fail", error: "claude-code wrote a line over 1 MiB" },
    ]);
    // Nothing after the failure is read.
    expect(s.push('{"type":"assistant"}\n')).toEqual([]);
  });

  test("a run over 64 MiB of output is stopped", () => {
    const s = new ClaudeStream();
    const line = `{"type":"system","subtype":"ui_invalidate","pad":"${"x".repeat(1_000_000)}"}\n`;
    let failed = null;
    for (let i = 0; i < 70 && !failed; i++) {
      failed = s.push(line).find((e) => e.type === "fail") ?? null;
    }
    expect(failed).toEqual({ type: "fail", error: "claude-code wrote over 64 MiB" });
  });

  test("an error result names its error", () => {
    const init = fixture("claude-code-2.1.303-task").split("\n")[0];
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Invalid API key · Please run /login",
      usage: { input_tokens: 0, output_tokens: 0 },
      total_cost_usd: 0,
    });
    const { out } = events(`${init}\n${result}\n`);
    expect(out.at(-1)).toEqual({
      type: "result",
      ok: false,
      error: "Invalid API key · Please run /login",
      usage: { input: 0, output: 0 },
      cost: 0,
      queued: 0,
    });
  });

  test("text is passed as written, and the window renders it as text", () => {
    const init = fixture("claude-code-2.1.303-task").split("\n")[0];
    const reply = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "<img src=x onerror=alert(1)> **b**" }] },
    });
    const { out } = events(`${init}\n${reply}\n`);
    expect(out[1]).toEqual({ type: "reply", text: "<img src=x onerror=alert(1)> **b**" });
  });
});

describe("the window's words (Behaviour 4, 9, 13)", () => {
  test("an own-tool line is cut at 200 characters", () => {
    const line = ownToolText(CLIS["claude-code"], "Bash", { command: "echo " + "y".repeat(400) });
    expect([...line].length).toBe(200);
    expect(line.startsWith('claude-code ran its own tool: Bash "echo yyy')).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(ownToolText(CLIS["claude-code"], "Read", { file_path: "/etc/hosts" })).toBe(
      'claude-code ran its own tool: Read "/etc/hosts"',
    );
    expect(ownToolText(CLIS["claude-code"], "WebFetch", { url: "https://e.x", prompt: "p" })).toBe(
      'claude-code ran its own tool: WebFetch "https://e.x"',
    );
    expect(ownToolText(CLIS["claude-code"], "Odd\nName", { a: 1 })).toBe(
      'claude-code ran its own tool: Odd Name {"a":1}',
    );
  });

  test("the first-task notice says where data goes and that the cli's own tools are not confined", () => {
    expect(cliNotice(CLIS["claude-code"])).toBe(
      "Page text the agent reads, field values it sees, screenshots and your messages go to " +
        "Claude Code, which sends them to the model it is set up for. Claude Code also keeps the " +
        "tools its own settings allow (shell, files, web); Vimma does not confine them. " +
        "y send · n cancel",
    );
  });

  test("an exit names the cli, its code and the last line of its error output, cut", () => {
    expect(exitText(CLIS["claude-code"], 1, "warning\nInvalid API key · Please run /login\n")).toBe(
      "claude-code exited (1): Invalid API key · Please run /login",
    );
    expect(exitText(CLIS["claude-code"], 2, "")).toBe("claude-code exited (2)");
    expect([...exitText(CLIS["claude-code"], 1, "e".repeat(500))].length).toBe(200);
    // Claude Code reports a refused key in its result, not on stderr.
    expect(exitText(CLIS["claude-code"], 1, "", "Invalid API key · Fix external API key")).toBe(
      "claude-code exited (1): Invalid API key · Fix external API key",
    );
  });
});

describe("the program's path (C4)", () => {
  const good = {
    absolute: true,
    regular: true,
    executable: true,
    owner: /** @type {const} */ ("user"),
    othersWrite: false,
    dirOwner: /** @type {const} */ ("user"),
    dirOthersWrite: false,
  };
  test("an absolute, regular, executable file of the user or root, that others cannot write", () => {
    expect(pathProblem(good)).toBe(null);
    expect(pathProblem({ ...good, owner: "root", dirOwner: "root" })).toBe(null);
  });
  test("anything else is refused, with the reason", () => {
    expect(pathProblem({ ...good, absolute: false })).toMatch(/absolute/);
    expect(pathProblem({ ...good, regular: false })).toMatch(/regular file/);
    expect(pathProblem({ ...good, executable: false })).toMatch(/executable/);
    expect(pathProblem({ ...good, owner: "other" })).toMatch(/owned by another user/);
    expect(pathProblem({ ...good, othersWrite: true })).toMatch(/other users can write/);
    expect(pathProblem({ ...good, dirOwner: "other" })).toMatch(/folder .*another user/);
    expect(pathProblem({ ...good, dirOthersWrite: true })).toMatch(/folder .*other users/);
  });
});
