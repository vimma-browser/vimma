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
  CODEX_SERVER,
  ClaudeStream,
  CodexStream,
  GEMINI_SERVER,
  GeminiStream,
  MAX_MODEL,
  claudeArguments,
  codexArguments,
  codexServers,
  cliEnvironment,
  cliNotice,
  dispatcherOf,
  dispatcherProblem,
  exitText,
  geminiArguments,
  geminiLeftover,
  geminiProjects,
  cliModelText,
  mcpConfig,
  modelProblem,
  modelPrompt,
  ownToolText,
  ownToolsText,
  pathProblem,
  refusedText,
  besideBinary,
  runStartedText,
  shimText,
  taskPrompt,
  userLine,
  versionText,
} from "../src/agent-cli.mjs";
import { STORE_VERSION, readRecord } from "../src/agent-store.mjs";
import { parseToml } from "../src/toml.mjs";

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

  test("a typed model is checked with the rule the arguments use", () => {
    for (const ok of ["sonnet", "opus", "claude-sonnet-5-5", ""]) {
      expect(modelProblem(ok)).toBeNull();
    }
    expect(modelProblem("--bare")).toBe(
      'the model "--bare" is not a model name: it cannot start with "-"',
    );
    expect(modelProblem("son\u0007net")).toBe(
      'the model "sonnet" is not a model name: it has control characters',
    );
    // The run refuses what setup refuses, with the same words.
    expect(() => claudeArguments({ mcpConfig: "/m.json", model: "--bare" })).toThrow(
      modelProblem("--bare") ?? "",
    );
  });

  test("every control character in a model is refused, tab, line feed and DEL included", () => {
    for (const bad of ["son\tnet", "sonnet\n--bare", "sonnet\r", "son\u007fnet", "\u0000"]) {
      expect(modelProblem(bad)).toMatch(/it has control characters$/);
    }
  });

  test("a model longer than config.toml allows is refused by the same rule", () => {
    expect(modelProblem("m".repeat(MAX_MODEL))).toBeNull();
    expect(modelProblem("m".repeat(MAX_MODEL + 1))).toMatch(
      new RegExp(`it is longer than ${MAX_MODEL} characters$`),
    );
    expect(() =>
      claudeArguments({ mcpConfig: "/m.json", model: "m".repeat(MAX_MODEL + 1) }),
    ).toThrow(/model/);
  });

  // A conversation read back from its file brings its provider's model with it: the run builds
  // its arguments from that model, so a stored option or a stored line break is refused there.
  test("a restored conversation's stored model is refused when the arguments are built", () => {
    for (const model of ["--bare", "sonnet\n--bare"]) {
      const record = readRecord({
        v: STORE_VERSION,
        id: "0f8fad5b-d9cb-469f-a165-70867728950e",
        title: "t",
        created: 1,
        used: 2,
        provider: { name: "claude", kind: "cli", cli: "claude-code", endpoint: "", model },
        entries: [{ kind: "user", text: "hi" }],
      });
      expect(record?.provider.model).toBe(model);
      expect(() =>
        claudeArguments({ mcpConfig: "/m.json", model: record?.provider.model ?? "" }),
      ).toThrow(modelProblem(model) ?? "never");
    }
  });

  test("setup suggests each cli's model, and empty is the cli's own default", () => {
    for (const info of Object.values(CLIS)) expect(modelProblem(info.model)).toBeNull();
    expect(CLIS["claude-code"]?.model).toBe("sonnet");
    expect(modelPrompt("claude-code")).toEqual({
      label: "agent model: ",
      value: "sonnet",
      placeholder: "empty: Claude Code's own default model",
    });
    expect(cliModelText("claude-code", "opus")).toBe("opus");
    expect(cliModelText("claude-code", "")).toBe("Claude Code's own default model");
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
        XRE_PROFILE_PATH: "/home/u/.config/vimma/abc.default",
        XRE_PROFILE_LOCAL_PATH: "/home/u/.cache/vimma/abc.default",
        XUL_APP_FILE: "/opt/vimma/application.ini",
        ANTHROPIC_API_KEY: "kept: the CLI's login is its own",
      }),
    ).toEqual({
      HOME: "/home/u",
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "kept: the CLI's login is its own",
    });
  });

  test("the run-started line lists the reported tools, each cut, and stays bounded", () => {
    const cli = CLIS["claude-code"];
    expect(runStartedText(cli, "2.1.303", "sonnet", ["Bash", "Read"])).toBe(
      "run started: claude-code 2.1.303 · sonnet · its own tools: Bash, Read",
    );
    expect(runStartedText(cli, "", "", [])).toBe(
      "run started: claude-code · its default model · its own tools: none",
    );
    const many = Array.from({ length: 500 }, (_, i) => `Tool${i}${"x".repeat(100)}`);
    const line = runStartedText(cli, "9".repeat(500), "m".repeat(500), many);
    expect([...line].length).toBeLessThanOrEqual(2000);
    expect(line).toMatch(/\+\d+$/);
  });

  test("the version line names the version and the path", () => {
    expect(
      versionText(CLIS["claude-code"], "2.1.303 (Claude Code)\n", "/home/u/.local/bin/claude"),
    ).toBe("claude 2.1.303 · /home/u/.local/bin/claude");
    expect(versionText(CLIS["claude-code"], "\u001b[31mweird\n", "/usr/bin/claude")).toBe(
      "claude [31mweird · /usr/bin/claude",
    );
  });

  test("a shim's line says which program it runs, and as what", () => {
    const cli = CLIS["claude-code"];
    const shim = shimText(cli, "mise", "/usr/bin/mise");
    expect(shim).toBe("a mise shim (runs /usr/bin/mise as claude)");
    expect(
      versionText(cli, "2.1.314 (Claude Code)\n", "/home/u/.local/share/mise/shims/claude", shim),
    ).toBe(
      "claude 2.1.314 · /home/u/.local/share/mise/shims/claude · a mise shim (runs /usr/bin/mise as claude)",
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

  test("a CLI's note on Vimma's tools goes first, so a denied tool of its own is not the end", () => {
    const cli = CLIS["claude-code"];
    expect(cli.note).toBe(
      "Vimma's note: search the web and read pages with Vimma's tools in the agent workspace " +
        "(for example, open a search engine's results page with vimma_open and read it with " +
        "vimma_read_page); tools of your own that this run was not allowed in advance are refused.",
    );
    expect(taskPrompt([], "Only this.", cli.note)).toBe(`${cli.note}\n\nOnly this.`);
    const later = taskPrompt([{ role: "user", text: "Find it." }], "Next.", cli.note);
    expect(later.startsWith(`${cli.note}\n\nEarlier in this conversation`)).toBe(true);
    expect(later.endsWith("Next.")).toBe(true);
  });
});

describe("claude-code's stream (C7, C8)", () => {
  test("a recorded claude-code stream maps to replies, own-tool lines, usage and cost", () => {
    const { out, stream } = events(fixture("claude-code-2.1.303-task"));
    expect(out.map((e) => e.type)).toEqual([
      "init",
      "usage",
      "reply",
      "own-tool",
      "own-tool-refused",
      "usage",
      "reply",
      "result",
    ]);
    expect(out[0]).toMatchObject({ type: "init", model: "claude-sonnet-5-5", version: "2.1.303" });
    expect(out[2]).toEqual({ type: "reply", text: "Let me look at the tabs." });
    expect(out[3]).toEqual({
      type: "own-tool",
      id: "toolu_msg_fake_1_1",
      text: 'claude-code ran its own tool: Bash "ls ~/Downloads"',
    });
    expect(out[4]).toEqual({ type: "own-tool-refused", id: "toolu_msg_fake_1_1" });
    expect(out[7]).toEqual({
      type: "result",
      ok: true,
      error: null,
      usage: { input: 2400, output: 80 },
      rest: { input: 0, output: 78 },
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
      rest: { input: 0, output: 0 },
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

  test("each model call's usage counts as it comes, once, and the result adds only the rest", () => {
    // max_tokens must be able to stop a turn before it ends (M59), and Claude Code repeats a
    // call's usage on each of its content blocks.
    const { out } = events(fixture("claude-code-2.1.303-task"));
    expect(out.filter((e) => e.type === "usage")).toEqual([
      { type: "usage", input: 1200, output: 1 },
      { type: "usage", input: 1200, output: 1 },
    ]);
    expect(out.at(-1)).toMatchObject({
      type: "result",
      usage: { input: 2400, output: 80 },
      rest: { input: 0, output: 78 },
    });
    const call = (/** @type {string} */ id, /** @type {number} */ input) =>
      JSON.stringify({
        type: "assistant",
        message: { id, content: [{ type: "text", text: "x" }], usage: { input_tokens: input } },
      });
    const result = JSON.stringify({
      type: "result",
      is_error: false,
      usage: { input_tokens: 500, output_tokens: 9 },
    });
    const turns = events(
      [call("a", 300), call("a", 300), result, call("b", 700), result].join("\n") + "\n",
    ).out;
    expect(turns.filter((e) => e.type === "usage").map((e) => e.input)).toEqual([300, 700]);
    // A turn whose calls reported more than its result counts nothing more at its end.
    expect(turns.filter((e) => e.type === "result").map((e) => e.rest)).toEqual([
      { input: 200, output: 9 },
      { input: 0, output: 9 },
    ]);
  });

  test("cached input counts as input, as a hosted provider's does", () => {
    // Claude Code caches its prompt: most of a call's input is cache creation or reads, and
    // max_tokens must mean the same for a CLI as for the Messages API provider.
    const call = JSON.stringify({
      type: "assistant",
      message: {
        id: "c1",
        content: [{ type: "text", text: "x" }],
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 900,
          cache_read_input_tokens: 5000,
          output_tokens: 1,
        },
      },
    });
    const result = JSON.stringify({
      type: "result",
      is_error: false,
      usage: {
        input_tokens: 3,
        cache_creation_input_tokens: 900,
        cache_read_input_tokens: 5000,
        output_tokens: 40,
      },
    });
    const { out } = events(`${call}\n${result}\n`);
    expect(out[0]).toEqual({ type: "usage", input: 5903, output: 1 });
    expect(out[2]).toMatchObject({
      usage: { input: 5903, output: 40 },
      rest: { input: 0, output: 39 },
    });
  });

  test("tools of another mcp server are the cli's own, listed and marked, not hidden", () => {
    // Only Vimma's tools are steps from the gate (C7): a server that is not Vimma's, however
    // it got loaded, must show in the header and as own-tool lines (M57, M58).
    const init = JSON.stringify({
      type: "system",
      subtype: "init",
      tools: ["Bash", "mcp__vimma__vimma_tabs", "mcp__other__fetch"],
      mcp_servers: [
        { name: "vimma", status: "connected" },
        { name: "other", status: "connected" },
      ],
      model: "m",
    });
    const use = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "u1", name: "mcp__other__fetch", input: {} }],
      },
    });
    const denied = JSON.stringify({
      type: "system",
      subtype: "permission_denied",
      tool_use_id: "u1",
      tool_name: "mcp__other__fetch",
    });
    const { out } = events(`${init}\n${use}\n${denied}\n`);
    expect(out[0]).toMatchObject({ type: "init", tools: ["Bash", "mcp__other__fetch"] });
    expect(out[1]).toMatchObject({ type: "own-tool", id: "u1" });
    expect(out[2]).toEqual({ type: "own-tool-refused", id: "u1" });
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
      rest: { input: 0, output: 0 },
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

  test("an exit with nothing on stdout names the program that ran", () => {
    expect(
      exitText(
        CLIS["claude-code"],
        2,
        "For more information, try '--help'.\n",
        "",
        "/usr/bin/mise",
      ),
    ).toBe("claude-code at /usr/bin/mise exited (2): For more information, try '--help'.");
    expect(exitText(CLIS["claude-code"], 2, "", "", "/usr/bin/mise")).toBe(
      "claude-code at /usr/bin/mise exited (2)",
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
    expect(pathProblem({ ...good, dirOwner: "other" })).toBe(
      "a folder it is in is owned by another user",
    );
    expect(pathProblem({ ...good, dirOthersWrite: true })).toBe(
      "a folder it is in can be written by other users",
    );
  });
  test("a link on the way to it is judged by its owner", () => {
    expect(pathProblem({ ...good, linkOwner: "root" })).toBe(null);
    expect(pathProblem({ ...good, linkOwner: "other" })).toBe(
      "a link on its path is owned by another user",
    );
  });
  // M56: vimma-ctl beside the binary skips the folders on the way to Vimma's binary, and only
  // when the file it resolves to is in the binary's own folder.
  describe("vimma-ctl beside the binary", () => {
    const trusted = { binDir: "/Apps/V/MacOS", dirs: ["/", "/Apps", "/Apps/V", "/Apps/V/MacOS"] };
    test("a file in the binary's folder skips only the binary's own folders and links", () => {
      const walk = {
        realDir: "/Apps/V/MacOS",
        dirs: ["/", "/Apps", "/Apps/V", "/Apps/V/MacOS"],
        links: [{ dir: "/Apps/V/MacOS", owner: /** @type {const} */ ("other") }],
      };
      expect(besideBinary(walk, trusted)).toEqual({ dirs: [], linkOwner: "user" });
    });
    test("a link through a hop in another folder has that folder and link judged", () => {
      const walk = {
        realDir: "/Apps/V/MacOS",
        dirs: ["/", "/Apps", "/Apps/V", "/Apps/V/MacOS", "/shared", "/shared/dir"],
        links: [
          { dir: "/Apps/V/MacOS", owner: /** @type {const} */ ("user") },
          { dir: "/shared/dir", owner: /** @type {const} */ ("other") },
        ],
      };
      expect(besideBinary(walk, trusted)).toEqual({
        dirs: ["/shared", "/shared/dir"],
        linkOwner: "other",
      });
    });
    test("a file outside the binary's folder has every folder and link judged", () => {
      const walk = {
        realDir: "/Apps/shared",
        dirs: ["/", "/Apps", "/Apps/V", "/Apps/V/MacOS", "/Apps/shared"],
        links: [{ dir: "/Apps/V/MacOS", owner: /** @type {const} */ ("other") }],
      };
      expect(besideBinary(walk, trusted)).toEqual({ dirs: walk.dirs, linkOwner: "other" });
    });
    test("without the binary's folder, everything is judged", () => {
      const walk = {
        realDir: "/Apps/V/MacOS",
        dirs: ["/", "/Apps/V/MacOS"],
        links: [{ dir: "/Apps/V/MacOS", owner: /** @type {const} */ ("root") }],
      };
      expect(besideBinary(walk, null)).toEqual({ dirs: walk.dirs, linkOwner: "user" });
    });
  });
  test("a program that runs a tool by the name it is started as is a dispatcher", () => {
    const cli = CLIS["claude-code"];
    expect(dispatcherOf(cli, "mise")).toBe("mise");
    expect(dispatcherOf(cli, "volta-shim")).toBe("volta-shim");
    // The CLI itself, Claude Code's native installer (a file per version), npm's script.
    expect(dispatcherOf(cli, "claude")).toBe(null);
    expect(dispatcherOf(cli, "2.1.250")).toBe(null);
    expect(dispatcherOf(cli, "cli.js")).toBe(null);
    expect(dispatcherProblem(cli, "mise")).toBe(
      "it is mise, which runs claude only through a link named claude",
    );
  });
  test("a refusal setup can repair says how", () => {
    const cli = CLIS["claude-code"];
    expect(refusedText(cli, "/usr/bin/mise", dispatcherProblem(cli, "mise"))).toBe(
      "claude-code at /usr/bin/mise is refused: it is mise, which runs claude only through a " +
        "link named claude; add: agent CLI finds it again",
    );
    expect(refusedText(cli, "/x/2.1.250", "it does not exist")).toBe(
      "claude-code at /x/2.1.250 is refused: it does not exist; add: agent CLI finds it again",
    );
    expect(refusedText(cli, "/x/claude", "other users can write it")).toBe(
      "claude-code at /x/claude is refused: other users can write it",
    );
    expect(refusedText(cli, "/x/claude", "it is not executable")).toBe(
      "claude-code at /x/claude is refused: it is not executable",
    );
  });
});

// docs/specs/builtin-agent-cli.md, "Adding a CLI": every per-CLI fact is in its CLIS entry, so a
// new entry that leaves one out fails here rather than in a run.
describe("every CLIS entry supplies the whole interface", () => {
  for (const [key, cli] of Object.entries(CLIS)) {
    test(`${key}`, () => {
      expect(cli.id).toBe(key);
      for (const word of [cli.bin, cli.title]) {
        expect(typeof word).toBe("string");
        expect(word.length).toBeGreaterThan(0);
      }
      expect(modelProblem(cli.model)).toBeNull();
      expect(cli.models).toContain(cli.model);
      expect(cli.models).toContain("");
      for (const m of cli.models) expect(modelProblem(m)).toBeNull();
      expect(Array.isArray(cli.versionArgs)).toBe(true);
      expect(cli.note).toMatch(/vimma_open/);
      const run = {
        mcpConfig: "/run/x/mcp.json",
        vimmaCtl: "/opt/vimma/vimma-ctl",
        dir: "/run/x",
        others: [],
      };
      const args = cli.args({ ...run, model: "m-1" });
      expect(args).toContain("m-1");
      expect(() => cli.args({ ...run, model: "--bare" })).toThrow();
      const ticket = "t".repeat(64);
      const config = cli.mcpConfig({ vimmaCtl: "/opt/vimma/vimma-ctl", ticket, port: 1 });
      const env = cli.env({ ticket, port: 1, dir: "/run/x" });
      // vimma-ctl is the one server, named in the file the arguments point at, in the run's
      // folder where the CLI looks for it, or in the arguments.
      expect(typeof cli.configFile).toBe("string");
      expect(Boolean(config)).toBe(Boolean(cli.configFile));
      if (config) expect(cli.configFile).toMatch(/^[\w.-]+(\/[\w.-]+)*$/);
      if (config && args.some((a) => a.startsWith("/run/x/"))) {
        expect(args).toContain(`/run/x/${cli.configFile}`);
      }
      expect(["none", "gemini-projects"]).toContain(cli.sessions);
      expect(`${JSON.stringify(config)} ${args.join(" ")}`).toContain("/opt/vimma/vimma-ctl");
      // The ticket reaches it through the file or the CLI's environment, never an argument.
      expect(args.join(" ")).not.toContain(ticket);
      expect(`${JSON.stringify(config)} ${Object.values(env).join(" ")}`).toContain(ticket);
      expect(typeof cli.live).toBe("boolean");
      expect(cli.servers === null || Array.isArray(cli.servers.args)).toBe(true);
      expect(cli.input("hello")).toMatch(/hello[\s\S]*\n$/);
      const stream = cli.stream({ model: "m-1" });
      expect(typeof stream.push).toBe("function");
      expect(typeof stream.end).toBe("function");
    });
  }
});

describe("a CLI's words come from its entry alone", () => {
  /** @type {any} */
  const made = {
    "made-up": {
      id: "made-up",
      bin: "mu",
      title: "Made Up",
      model: "small",
      models: ["small", "large", ""],
    },
  };

  test("setup's prompt and a model's name use its entry", () => {
    expect(modelPrompt("made-up", made)).toEqual({
      label: "agent model: ",
      value: "small",
      placeholder: "empty: Made Up's own default model",
    });
    expect(cliModelText("made-up", "", made)).toBe("Made Up's own default model");
    expect(cliModelText("made-up", "large", made)).toBe("large");
  });
});

// Codex 0.163.0, recorded as Claude Code was: `codex exec` with the arguments below against a
// scripted OpenAI Responses server on 127.0.0.1, a made-up key, a throwaway HOME whose
// config.toml also had an MCP server named `other`, and a one-tool MCP server for Vimma's. Its
// model was unknown to Codex, hence the first item, a warning about the model's metadata.
/** Every event of a whole Codex stream, fed in chunks that cut lines in two. */
function codexEvents(/** @type {string} */ text, chunk = 97) {
  const s = new CodexStream({ model: "" });
  const out = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...s.push(text.slice(i, i + chunk)));
  out.push(...s.end());
  return { out, stream: s };
}

const CTL = "/opt/vimma/vimma-ctl";
const RUN = "/run/user/1000/vimma-agent-cli-a1b2c3";
const VIMMA_TABLE =
  `mcp_servers.${"vimma_chat"}={command="${CTL}",args=["mcp"],` +
  'env_vars=["VIMMA_AGENT_TICKET","VIMMA_AGENT_PORT"],' +
  'default_tools_approval_mode="approve",required=true,enabled=true}';

describe("codex's command line (C2, C3, C7)", () => {
  test("codex's arguments are the fixture", () => {
    expect(codexArguments({ vimmaCtl: CTL, dir: RUN, model: "", others: [] })).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      RUN,
      "-c",
      VIMMA_TABLE,
      "-c",
      'shell_environment_policy.set.VIMMA_AGENT_TICKET=""',
      "-c",
      'shell_environment_policy.set.VIMMA_AGENT_PORT=""',
      "--disable",
      "apps",
      "--disable",
      "plugins",
      "--disable",
      "skill_mcp_dependency_install",
      "-",
    ]);
    expect(
      codexArguments({ vimmaCtl: CTL, dir: RUN, model: "gpt-6-astra", others: [] }).slice(-3),
    ).toEqual(["-m", "gpt-6-astra", "-"]);
    expect(CODEX_SERVER).toBe("vimma_chat");
  });

  test("every other mcp server of codex's configuration is off for the run", () => {
    const args = codexArguments({ vimmaCtl: CTL, dir: RUN, model: "", others: ["vimma", "other"] });
    expect(args.slice(12, 16)).toEqual([
      "-c",
      "mcp_servers.vimma.enabled=false",
      "-c",
      "mcp_servers.other.enabled=false",
    ]);
  });

  test("codex's features that add mcp servers are off, and fail the run once renamed", () => {
    const args = codexArguments({ vimmaCtl: CTL, dir: RUN, model: "", others: [] });
    // As a -c key, a feature Codex does not know is ignored; as --disable it ends the run, so
    // a version that renames one fails instead of keeping its servers.
    const off = args.flatMap((a, i) => (args[i - 1] === "--disable" ? [a] : []));
    expect(off).toEqual(["apps", "plugins", "skill_mcp_dependency_install"]);
    expect(args.some((a) => a.startsWith("features."))).toBe(false);
  });

  test("a server name that is not a plain word, or is vimma's own, refuses the run", () => {
    for (const name of ['a"b', "a.b", "a b", "", "x=1", CODEX_SERVER]) {
      expect(() => codexArguments({ vimmaCtl: CTL, dir: RUN, model: "", others: [name] })).toThrow(
        /MCP server/,
      );
    }
  });

  test("vimma-ctl's path is a TOML string whatever it holds", () => {
    const odd = '/home/u/a "b" \\c\u007fd\ne/vimma-ctl';
    const args = codexArguments({ vimmaCtl: odd, dir: RUN, model: "", others: [] });
    const parsed = /** @type {any} */ (parseToml(args[7] ?? "")).value;
    expect(parsed.mcp_servers.vimma_chat.command).toBe(odd);
    expect(parsed.mcp_servers.vimma_chat.env_vars).toEqual([
      "VIMMA_AGENT_TICKET",
      "VIMMA_AGENT_PORT",
    ]);
  });

  test("the ticket reaches vimma-ctl through codex's environment, never its arguments", () => {
    const codex = /** @type {any} */ (CLIS.codex);
    const ticket = "ab".repeat(32);
    expect(codex.mcpConfig({ vimmaCtl: CTL, ticket, port: 4123 })).toBeNull();
    expect(codex.env({ ticket, port: 4123 })).toEqual({
      VIMMA_AGENT_TICKET: ticket,
      VIMMA_AGENT_PORT: "4123",
    });
    expect(CLIS["claude-code"]?.env({ ticket, port: 4123 })).toEqual({});
    const args = codex.args({ mcpConfig: "", vimmaCtl: CTL, dir: RUN, model: "", others: [] });
    expect(args.join(" ")).not.toContain(ticket);
  });

  test("codex's own commands get the ticket's variables empty, the user's policy kept", () => {
    // Codex 0.163.0 gives its shell commands its own environment: VIMMA_AGENT_TICKET included.
    // A `set` key merges into the user's table; an `exclude` list would replace the user's.
    const args = codexArguments({ vimmaCtl: CTL, dir: RUN, model: "", others: [] });
    const values = args.filter((_, i) => args[i - 1] === "-c");
    for (const name of ["VIMMA_AGENT_TICKET", "VIMMA_AGENT_PORT"]) {
      const v = values.find((x) => x.startsWith(`shell_environment_policy.set.${name}=`));
      const parsed = /** @type {any} */ (parseToml(v ?? "")).value;
      expect(parsed.shell_environment_policy.set[name]).toBe("");
    }
    expect(values.some((x) => /^shell_environment_policy\.(exclude|inherit)/.test(x))).toBe(false);
  });

  test("the task is never an argument, and goes to stdin, which then closes", () => {
    const codex = /** @type {any} */ (CLIS.codex);
    const task = '--dangerously-bypass-approvals-and-sandbox; rm -rf ~ "q" $(x)';
    expect(codex.input(task)).toBe(`${task}\n`);
    expect(codex.live).toBe(false);
    expect(CLIS["claude-code"]?.live).toBe(true);
    // stdin, the last argument: `codex exec` reads the prompt from it to its end.
    expect(codexArguments({ vimmaCtl: CTL, dir: RUN, model: "", others: [] }).at(-1)).toBe("-");
  });

  test("codex's own mcp servers are read from its list", () => {
    const codex = /** @type {any} */ (CLIS.codex);
    expect(codex.servers.args).toEqual(["mcp", "list", "--json"]);
    const listed = readFileSync(
      new URL("fixtures/agent-cli/codex-0.163.0-mcp-list.json", import.meta.url),
      "utf8",
    );
    expect(codexServers(listed)).toEqual(["other"]);
    expect(codexServers("[]")).toEqual([]);
    for (const bad of ["", "{}", "not json", '[{"name":1}]', "[null]"]) {
      expect(codexServers(bad)).toEqual({
        problem: "codex listed its MCP servers in a form Vimma does not read",
      });
    }
  });

  test("codex's version line drops the program's name", () => {
    expect(
      versionText(/** @type {any} */ (CLIS.codex), "codex-cli 0.163.0\n", "/usr/bin/codex"),
    ).toBe("codex 0.163.0 · /usr/bin/codex");
  });

  test("codex's suggested model is its own default", () => {
    expect(CLIS.codex?.model).toBe("");
    expect(modelPrompt("codex")).toEqual({
      label: "agent model: ",
      value: "",
      placeholder: "empty: Codex's own default model",
    });
  });
});

describe("codex's stream (C7, C8)", () => {
  test("a recorded codex stream maps to replies, own-tool lines and usage", () => {
    const { out, stream } = codexEvents(fixture("codex-0.163.0-task"));
    expect(out).toEqual([
      { type: "init", model: "", version: "", tools: null },
      {
        type: "own-tool",
        id: "item_2",
        text: "codex ran its own tool: shell \"/usr/bin/bash -lc 'ls ~/Downloads'\"",
      },
      { type: "reply", text: "Two tabs are open: Example and Shop." },
      {
        type: "result",
        ok: true,
        error: null,
        usage: { input: 3900, output: 123 },
        rest: { input: 3900, output: 123 },
        cost: null,
        queued: 0,
      },
    ]);
    // The model warning, the turn's start, the vimma call and the command's end.
    expect(stream.ignored).toBeGreaterThan(0);
  });

  test("a run with no reported tool list says its configuration decides", () => {
    expect(runStartedText(/** @type {any} */ (CLIS.codex), "", "", null)).toBe(
      "run started: codex · its default model · its own tools: as its configuration allows",
    );
  });

  test("a file change is an own-tool line naming its files", () => {
    const { out } = codexEvents(fixture("codex-0.163.0-file-change"));
    expect(out.filter((e) => e.type === "own-tool")).toEqual([
      {
        type: "own-tool",
        id: "item_0",
        text: 'codex ran its own tool: apply_patch "add /tmp/rec/work/notes.txt"',
      },
    ]);
  });

  test("mcp tool calls of vimma's server are not transcript steps", () => {
    const { out } = codexEvents(fixture("codex-0.163.0-task"));
    expect(out.map((e) => JSON.stringify(e)).some((t) => t.includes("vimma_tabs"))).toBe(false);
  });

  test("a call to any other mcp server ends the run", () => {
    const line = JSON.stringify({
      type: "item.started",
      item: { id: "item_1", type: "mcp_tool_call", server: "other", tool: "x", arguments: {} },
    });
    const { out, stream } = codexEvents(`${line}\n${line}\n`);
    expect(out).toEqual([
      { type: "fail", error: "codex called an MCP server that is not Vimma's: other" },
    ]);
    expect(stream.failed).toBe(true);
  });

  test("a key the provider refuses ends in an error result, after the cli's retries", () => {
    const { out } = codexEvents(fixture("codex-0.163.0-bad-key"));
    const result = /** @type {any} */ (out.at(-1));
    expect(result).toMatchObject({ type: "result", ok: false, usage: null, cost: null });
    expect(result.error).toMatch(/^unexpected status 401 Unauthorized: Incorrect API key/);
    expect(out.filter((e) => e.type === "result")).toHaveLength(1);
  });

  test("a run that ends without its turn's result reports codex's last error", () => {
    const lines = [
      { type: "thread.started", thread_id: "t" },
      { type: "error", message: "stream disconnected before completion" },
    ];
    const { out } = codexEvents(lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(out.at(-1)).toEqual({
      type: "result",
      ok: false,
      error: "stream disconnected before completion",
      usage: null,
      rest: null,
      cost: null,
      queued: 0,
    });
  });

  test("a turn's end that no longer parses ends the run", () => {
    const { out } = codexEvents(`${JSON.stringify({ type: "turn.completed", usage: 5 })}\n`);
    expect(out).toEqual([{ type: "fail", error: "codex speaks a stream Vimma does not read" }]);
  });

  test("an unknown event is ignored and counted, and a long line ends the run", () => {
    const { out, stream } = codexEvents('{"type":"thread.renamed"}\n');
    expect(out).toEqual([]);
    expect(stream.ignored).toBe(1);
    const s = new CodexStream({ model: "" });
    expect(s.push(`{"x":"${"a".repeat(CLI_STREAM_LIMITS.line)}"}\n`)).toEqual([
      { type: "fail", error: "codex wrote a line over 1 MiB" },
    ]);
  });
});

// Gemini CLI 0.66.0, recorded as Codex was (issue #726): headless with the arguments below,
// inside a network namespace that has only loopback, against a scripted Gemini API server
// (`GOOGLE_GEMINI_BASE_URL`, a made-up key), a throwaway HOME, and a one-tool MCP server named
// vimma_chat in the run folder's `.gemini/settings.json`. The model asked for Vimma's tool, then
// for a shell command, which headless Gemini CLI does not offer; the bad-key run had the server
// answer 401.
/** Every event of a whole Gemini CLI stream, fed in chunks that cut lines in two. */
function geminiEvents(/** @type {string} */ text, chunk = 97) {
  const s = new GeminiStream({ model: "" });
  const out = [];
  for (let i = 0; i < text.length; i += chunk) out.push(...s.push(text.slice(i, i + chunk)));
  out.push(...s.end());
  return { out, stream: s };
}

const GEMINI = /** @type {any} */ (CLIS.gemini);

describe("gemini's command line (C2, C3, C5, C7)", () => {
  test("gemini's arguments are the fixture", () => {
    expect(geminiArguments({ model: "" })).toEqual([
      "-o",
      "stream-json",
      "--allowed-mcp-server-names",
      "vimma_chat",
      "-e",
      "none",
    ]);
    expect(geminiArguments({ model: "pro" }).slice(-2)).toEqual(["-m", "pro"]);
    expect(() => geminiArguments({ model: "--yolo" })).toThrow();
    expect(GEMINI_SERVER).toBe("vimma_chat");
  });

  test("vimma's server is in the run folder's settings file, the ticket in its env", () => {
    const ticket = "ab".repeat(32);
    expect(GEMINI.configFile).toBe(".gemini/settings.json");
    expect(GEMINI.mcpConfig({ vimmaCtl: CTL, ticket, port: 4123 })).toEqual({
      mcpServers: {
        vimma_chat: {
          command: CTL,
          args: ["mcp"],
          env: { VIMMA_AGENT_TICKET: ticket, VIMMA_AGENT_PORT: "4123" },
          trust: true,
        },
      },
    });
    const args = GEMINI.args({ mcpConfig: "", vimmaCtl: CTL, dir: RUN, model: "", others: [] });
    expect(args.join(" ")).not.toContain(ticket);
    expect(args.join(" ")).not.toContain(CTL);
  });

  test("gemini trusts the run folder from its environment, and keeps its reports there", () => {
    // --skip-trust trusts the folder but does not load its settings file; the variable does
    // both. An error report holds the conversation and goes to TMPDIR, which is the run's folder.
    const env = GEMINI.env({ ticket: "ab".repeat(32), port: 4123, dir: RUN });
    expect(env).toEqual({ GEMINI_CLI_TRUST_WORKSPACE: "true", TMPDIR: RUN });
  });

  test("the task goes to stdin, which then closes, and gemini's runs are cleaned up", () => {
    const task = '--yolo "q" $(x)';
    expect(GEMINI.input(task)).toBe(`${task}\n`);
    expect(GEMINI.live).toBe(false);
    expect(GEMINI.servers).toBeNull();
    expect(GEMINI.sessions).toBe("gemini-projects");
    expect(CLIS.codex?.sessions).toBe("none");
    expect(CLIS["claude-code"]?.sessions).toBe("none");
  });

  test("gemini's version line and suggested model", () => {
    expect(versionText(GEMINI, "0.66.0\n", "/usr/bin/gemini")).toBe(
      "gemini 0.66.0 · /usr/bin/gemini",
    );
    expect(GEMINI.model).toBe("");
    expect(modelPrompt("gemini").placeholder).toBe("empty: Gemini CLI's own default model");
  });
});

describe("gemini's stream (C7, C8)", () => {
  test("a recorded gemini stream maps to replies, own-tool lines and usage", () => {
    const { out, stream } = geminiEvents(fixture("gemini-0.66.0-task"));
    const shell = "run_shell_command__run_shell_command_1793818749495_0";
    expect(out).toEqual([
      { type: "init", model: "", version: "", tools: null },
      {
        type: "own-tool",
        id: shell,
        text: 'gemini ran its own tool: run_shell_command "ls /"',
      },
      { type: "own-tool-refused", id: shell },
      { type: "reply", text: "Done: you have one tab." },
      {
        type: "result",
        ok: true,
        error: null,
        usage: { input: 403, output: 28 },
        rest: { input: 403, output: 28 },
        cost: null,
        queued: 0,
      },
    ]);
    // The task echoed back, and vimma's own call and its result.
    expect(stream.ignored).toBeGreaterThan(0);
  });

  test("the pieces of one reply are joined, and a tool call between them splits it", () => {
    const lines = [
      { type: "init", session_id: "s", model: "auto" },
      { type: "message", role: "assistant", content: "Let me ", delta: true },
      { type: "message", role: "assistant", content: "look.", delta: true },
      { type: "tool_use", tool_name: "mcp_vimma_chat_vimma_tabs", tool_id: "a", parameters: {} },
      { type: "tool_result", tool_id: "a", status: "success", output: "1 tab" },
      { type: "message", role: "assistant", content: "One tab.", delta: true },
    ];
    const { out } = geminiEvents(lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(out.filter((e) => e.type === "reply")).toEqual([
      { type: "reply", text: "Let me look." },
      { type: "reply", text: "One tab." },
    ]);
    expect(out.map((e) => JSON.stringify(e)).some((t) => t.includes("vimma_tabs"))).toBe(false);
  });

  test("a tool of another mcp server that ran ends the run; one never offered does not", () => {
    const use = (/** @type {string} */ id) =>
      JSON.stringify({
        type: "tool_use",
        tool_name: "mcp_other_read",
        tool_id: id,
        parameters: {},
      });
    const missing = JSON.stringify({
      type: "tool_result",
      tool_id: "x",
      status: "error",
      error: { type: "tool_not_registered", message: "not found" },
    });
    expect(geminiEvents(`${use("x")}\n${missing}\n`).out).toEqual([
      { type: "own-tool", id: "x", text: "gemini ran its own tool: mcp_other_read {}" },
      { type: "own-tool-refused", id: "x" },
    ]);
    const ran = JSON.stringify({ type: "tool_result", tool_id: "y", status: "success" });
    const { out, stream } = geminiEvents(`${use("y")}\n${ran}\n${use("z")}\n`);
    expect(out.at(-1)).toEqual({
      type: "fail",
      error: "gemini called an MCP server that is not Vimma's: mcp_other_read",
    });
    expect(stream.failed).toBe(true);
  });

  test("a step its policy refuses is marked refused", () => {
    const lines = [
      { type: "tool_use", tool_name: "write_file", tool_id: "w", parameters: { file_path: "/a" } },
      { type: "tool_result", tool_id: "w", status: "error", error: { type: "policy_violation" } },
    ];
    const { out } = geminiEvents(lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(out).toEqual([
      { type: "own-tool", id: "w", text: 'gemini ran its own tool: write_file "/a"' },
      { type: "own-tool-refused", id: "w" },
    ]);
  });

  test("a key the provider refuses ends in an error result", () => {
    const { out } = geminiEvents(fixture("gemini-0.66.0-bad-key"));
    const result = /** @type {any} */ (out.at(-1));
    expect(result).toMatchObject({ type: "result", ok: false, cost: null });
    expect(result.error).toMatch(/API key not valid/);
    expect(out.filter((e) => e.type === "result")).toHaveLength(1);
  });

  test("a run that ends without its result reports gemini's last error", () => {
    const lines = [
      { type: "init", session_id: "s", model: "auto" },
      { type: "error", severity: "error", message: "quota exhausted" },
    ];
    const { out } = geminiEvents(lines.map((l) => JSON.stringify(l)).join("\n"));
    expect(out.at(-1)).toEqual({
      type: "result",
      ok: false,
      error: "quota exhausted",
      usage: null,
      rest: null,
      cost: null,
      queued: 0,
    });
  });

  test("a result that no longer parses ends the run", () => {
    const { out } = geminiEvents(`${JSON.stringify({ type: "result", status: "maybe" })}\n`);
    expect(out).toEqual([{ type: "fail", error: "gemini speaks a stream Vimma does not read" }]);
  });
});

// docs/specs/builtin-agent-cli.md C5 (Since changed): Gemini CLI records every run in
// ~/.gemini; Vimma removes what its own runs left there, found by the run's folder, never a
// project of the user's.
describe("gemini's records of vimma's runs (C5)", () => {
  const BASES = ["/run/user/1000", "/home/u/.cache/vimma-agent-cli"];

  test("only a run folder of vimma's is one of its runs", () => {
    for (const p of [
      "/run/user/1000/vimma-agent-cli",
      "/run/user/1000/vimma-agent-cli-12",
      "/home/u/.cache/vimma-agent-cli/vimma-agent-cli-3",
    ]) {
      expect(geminiLeftover(p, BASES)).toBe(true);
    }
    for (const p of [
      "/home/u/projects/vimma-agent-cli",
      "/run/user/1000/vimma-agent-cli-x",
      "/run/user/1000/vimma-agent-cli/sub",
      "/run/user/1000/other",
      "/run/user/1000/../1000/vimma-agent-cli",
      "relative/vimma-agent-cli",
    ]) {
      expect(geminiLeftover(p, BASES)).toBe(false);
    }
  });

  test("the registry keeps every other project, and names the runs' folders", () => {
    const registry = JSON.stringify({
      projects: {
        "/home/u/code/app": "app",
        "/run/user/1000/vimma-agent-cli-2": "vimma-agent-cli-2",
        "/run/user/1000/vimma-agent-cli": "vimma-agent-cli",
      },
    });
    const r = geminiProjects(registry, (p) => p === "/run/user/1000/vimma-agent-cli-2");
    expect(r.removed).toEqual([
      { path: "/run/user/1000/vimma-agent-cli-2", slug: "vimma-agent-cli-2" },
    ]);
    expect(JSON.parse(/** @type {string} */ (r.text))).toEqual({
      projects: {
        "/home/u/code/app": "app",
        "/run/user/1000/vimma-agent-cli": "vimma-agent-cli",
      },
    });
  });

  test("a slug that is not a plain folder name is never a folder to remove", () => {
    const registry = JSON.stringify({
      projects: {
        "/run/user/1000/vimma-agent-cli": "..",
        "/run/user/1000/vimma-agent-cli-1": "a/b",
        "/run/user/1000/vimma-agent-cli-2": "",
      },
    });
    const r = geminiProjects(registry, () => true);
    expect(r.removed.map((x) => x.slug)).toEqual([null, null, null]);
    expect(JSON.parse(/** @type {string} */ (r.text))).toEqual({ projects: {} });
  });

  test("a registry it cannot read is left as it is", () => {
    for (const bad of ["", "not json", "[]", '{"projects":[]}', '{"projects":{"/a":1}}']) {
      expect(geminiProjects(bad, () => true)).toEqual({ text: null, removed: [] });
    }
    // Nothing of vimma's in it: nothing to write.
    expect(geminiProjects('{"projects":{"/a":"a"}}', () => false)).toEqual({
      text: null,
      removed: [],
    });
  });
});
