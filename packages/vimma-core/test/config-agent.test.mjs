// docs/specs/builtin-agent.md Behaviour 8-9, 32, 34, B8, B10, B11, B17: `[agent]`, a schema-2
// table with the providers by endpoint and model only.
import { describe, expect, test } from "vitest";
import { AGENT_DEFAULTS, parseConfig } from "../src/config.mjs";

/** @param {...string} lines */
const v2 = (...lines) => ["schema = 2", ...lines].join("\n") + "\n";

/** @param {string} text */
function ok(text) {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  return /** @type {import("../src/config.mjs").ResolvedConfig} */ (r.config);
}

/** @param {string} text */
const errors = (text) => parseConfig(text).errors;

const LOCAL = [
  "[[agent.providers]]",
  'name = "local"',
  'kind = "openai"',
  'endpoint = "http://127.0.0.1:11434/v1"',
  'model = "qwen3:14b"',
];
const HOSTED = [
  "[[agent.providers]]",
  'name = "anthropic"',
  'kind = "anthropic"',
  'endpoint = "https://api.anthropic.com"',
  'model = "claude-sonnet-4-5"',
  "price_in = 3.00",
  "price_out = 15",
];

describe("[agent]", () => {
  test("the defaults: no provider, three running tasks, the bench's budgets", () => {
    expect(ok(v2()).agent).toEqual({
      default: null,
      localOnly: false,
      maxRunning: 3,
      maxSteps: 100,
      maxTokens: 2_000_000,
      maxCost: 2,
      keepDays: null,
      keepResults: null,
      providers: [],
    });
    expect(AGENT_DEFAULTS.maxRunning).toBe(3);
  });

  test("[agent] providers parse", () => {
    const agent = ok(
      v2(
        "[agent]",
        'default = "local"',
        "local_only = false",
        "max_running = 2",
        "max_steps = 60",
        "max_tokens = 500000",
        "max_cost = 1.5",
        "keep_days = 30",
        "keep_results = 10",
        ...LOCAL,
        "vision = false",
        ...HOSTED,
      ),
    ).agent;
    expect(agent).toEqual({
      default: "local",
      localOnly: false,
      maxRunning: 2,
      maxSteps: 60,
      maxTokens: 500000,
      maxCost: 1.5,
      keepDays: 30,
      keepResults: 10,
      providers: [
        {
          name: "local",
          kind: "openai",
          endpoint: "http://127.0.0.1:11434/v1",
          model: "qwen3:14b",
          vision: false,
        },
        {
          name: "anthropic",
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          model: "claude-sonnet-4-5",
          vision: true,
          priceIn: 3,
          priceOut: 15,
        },
      ],
    });
  });

  test("vision defaults to true for anthropic and false for openai (B7)", () => {
    const [local, hosted] = ok(v2(...LOCAL, ...HOSTED)).agent.providers;
    expect(local.vision).toBe(false);
    expect(hosted.vision).toBe(true);
  });

  test("a key field in [agent] is an error, with its line", () => {
    const said =
      "an API key must not be in config.toml: Vimma keeps it in login storage, set in the agent's setup";
    expect(errors(v2("[agent]", 'api_key = "sk-1"'))).toEqual([
      { line: 3, path: "agent.api_key", message: said },
    ]);
    for (const key of ["key", "token", "password"]) {
      const e = errors(v2(...LOCAL, `${key} = "x"`));
      expect(e).toEqual([{ line: 7, path: `agent.providers[0].${key}`, message: said }]);
    }
  });

  test("the key's value never appears in the error", () => {
    const e = errors(v2(...HOSTED, 'api_key = "sk-ant-secret-1234"'));
    expect(JSON.stringify(e)).not.toContain("sk-ant-secret");
  });

  test("task_grant_minutes is not a key of [agent]", () => {
    expect(errors(v2("[agent]", "task_grant_minutes = 30"))[0]).toMatchObject({
      path: "agent.task_grant_minutes",
      message: 'unknown key "task_grant_minutes"',
    });
  });

  test("local_only refuses a remote endpoint", () => {
    expect(errors(v2("[agent]", "local_only = true", ...HOSTED))).toEqual([
      {
        line: 7,
        path: "agent.providers[0].endpoint",
        message: "local_only refuses api.anthropic.com",
      },
    ]);
    expect(ok(v2("[agent]", "local_only = true", ...LOCAL)).agent.localOnly).toBe(true);
  });

  test("an endpoint off this machine must be https, and carry no user name", () => {
    const at = (/** @type {string} */ url) =>
      errors(v2(...LOCAL.slice(0, 3), `endpoint = "${url}"`, 'model = "m"'))[0]?.message;
    expect(at("http://llm.example/v1")).toBe(
      "an endpoint that is not on this machine must be https://",
    );
    expect(at("https://u:p@llm.example/v1")).toBe(
      "an endpoint must not carry a user name or password",
    );
    expect(at("ftp://127.0.0.1/")).toBe("an endpoint must be an http:// or https:// address");
    expect(at("http://[::1]:8080/v1")).toBeUndefined();
  });

  test("max_running and keep_days parse within their bounds", () => {
    expect(ok(v2("[agent]", "max_running = 1")).agent.maxRunning).toBe(1);
    expect(ok(v2("[agent]", "keep_days = 1")).agent.keepDays).toBe(1);
    const at = (/** @type {string} */ line) => errors(v2("[agent]", line))[0]?.message;
    expect(at("max_running = 0")).toBe("must be an integer between 1 and 10");
    expect(at("max_running = 11")).toBe("must be an integer between 1 and 10");
    expect(at("keep_days = 0")).toBe("must be an integer between 1 and 3650 (days)");
    expect(at("max_steps = 0")).toBe("must be an integer between 1 and 1000");
    expect(ok(v2("[agent]", "keep_results = 0")).agent.keepResults).toBe(0);
    expect(at("keep_results = -1")).toBe("must be an integer between 0 and 1000");
    expect(at("keep_results = 1001")).toBe("must be an integer between 0 and 1000");
    expect(at("max_tokens = 999")).toBe("must be an integer between 1000 and 100000000");
    expect(at("max_cost = 0")).toBe("must be a number above 0 and at most 1000");
    expect(at('max_steps = "60"')).toBe("expected an integer, got a string");
    expect(at("local_only = 1")).toBe("expected a boolean, got an integer");
  });

  test("a provider needs a unique name, a kind, an endpoint and a model", () => {
    expect(errors(v2("[[agent.providers]]", 'name = "x"')).map((e) => e.message)).toEqual([
      'a provider needs "kind", "endpoint" and "model"',
    ]);
    expect(errors(v2(...LOCAL, ...LOCAL))[0]).toMatchObject({
      path: "agent.providers[1].name",
      message: 'a second provider named "local"',
    });
    expect(errors(v2(...LOCAL.slice(0, 2), 'kind = "gemini"', ...LOCAL.slice(3)))[0]?.message).toBe(
      'must be "openai", "anthropic" or "cli"',
    );
    expect(errors(v2(...HOSTED.slice(0, -1)))[0]?.message).toBe(
      "price_in and price_out go together",
    );
  });

  test("default names a provider", () => {
    expect(errors(v2("[agent]", 'default = "nope"', ...LOCAL))[0]).toMatchObject({
      path: "agent.default",
      message: 'no provider is named "nope"',
    });
  });

  test("[agent] is new in schema 2", () => {
    expect(errors(["schema = 1", "[agent]", "max_steps = 5"].join("\n"))[0]?.message).toBe(
      "is new in schema 2: put schema = 2 at the top of the file",
    );
  });
});

describe("[[agent.providers]] of kind cli (docs/specs/builtin-agent-cli.md C4, C10, C11)", () => {
  const CLI = ["[[agent.providers]]", 'name = "claude"', 'kind = "cli"', 'cli = "claude-code"'];
  const NO_PROGRAM =
    "a CLI provider names no program, arguments or environment: setup confirms the program's path";

  test("a cli provider parses with cli and model", () => {
    expect(ok(v2(...CLI, 'model = "sonnet"')).agent.providers).toEqual([
      {
        name: "claude",
        kind: "cli",
        cli: "claude-code",
        endpoint: "",
        model: "sonnet",
        vision: false,
        maxMinutes: 30,
      },
    ]);
    // No model: the CLI's own default, which its run reports.
    expect(ok(v2(...CLI)).agent.providers[0]?.model).toBe("");
  });

  test("command, path, args and env in a cli provider are errors with their line", () => {
    for (const [key, value] of [
      ["command", '"/bin/sh"'],
      ["path", '"/tmp/claude"'],
      ["args", '["--dangerously-skip-permissions"]'],
      ["env", '{ LD_PRELOAD = "/tmp/x.so" }'],
    ]) {
      expect(errors(v2(...CLI, `${key} = ${value}`))).toEqual([
        { line: 6, path: `agent.providers[0].${key}`, message: NO_PROGRAM },
      ]);
    }
  });

  test("a cli provider takes no endpoint, and needs its cli", () => {
    expect(errors(v2(...CLI, 'endpoint = "https://x.example"'))[0]).toMatchObject({
      path: "agent.providers[0].endpoint",
      message: "a CLI provider has no endpoint: the CLI decides where it sends requests",
    });
    expect(errors(v2(...CLI.slice(0, 3)))[0]?.message).toBe('a CLI provider needs "cli"');
    expect(errors(v2(...CLI.slice(0, 3), 'cli = "claude-cod"'))[0]).toMatchObject({
      path: "agent.providers[0].cli",
      message: 'must be "claude-code"',
      suggestion: "claude-code",
    });
  });

  test("a cli provider's model is refused by the rule its run uses", () => {
    expect(errors(v2(...CLI, 'model = "--bare"'))[0]).toMatchObject({
      path: "agent.providers[0].model",
      message: 'the model "--bare" is not a model name: it cannot start with "-"',
    });
  });

  test("local_only refuses a cli provider", () => {
    expect(errors(v2("[agent]", "local_only = true", ...CLI))[0]).toMatchObject({
      path: "agent.providers[0].kind",
      message: "an agent CLI may send page text off this machine ([agent] local_only)",
    });
  });

  test("max_minutes parses within its bounds", () => {
    expect(ok(v2(...CLI, "max_minutes = 5")).agent.providers[0]).toMatchObject({ maxMinutes: 5 });
    expect(ok(v2(...CLI, "max_minutes = 1440")).agent.providers[0]).toMatchObject({
      maxMinutes: 1440,
    });
    for (const bad of ["0", "1441", "2.5"]) {
      expect(errors(v2(...CLI, `max_minutes = ${bad}`))[0]?.path).toBe(
        "agent.providers[0].max_minutes",
      );
    }
    // Only a CLI's: a model provider's task is bounded by its steps and tokens.
    expect(errors(v2(...LOCAL, "max_minutes = 5"))[0]?.path).toBe("agent.providers[0].max_minutes");
  });
});
