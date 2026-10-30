// docs/specs/builtin-agent.md Behaviour 2-3, B12: the provider setup picks is written to
// config.toml, and becomes `[agent] default` when none was set up, so it survives a restart.
// The file's other lines stay as they are, and nothing secret is ever written.
import { describe, expect, test } from "vitest";
import { addAgentProviderText, parseConfig } from "../src/config.mjs";
import { formatConfigTemplate } from "../src/defaults.mjs";

const ollama = {
  name: "ollama",
  kind: "openai",
  endpoint: "http://127.0.0.1:11434/v1",
  model: "qwen3:14b-ctx32768",
  vision: false,
};
const anthropic = {
  name: "anthropic",
  kind: "anthropic",
  endpoint: "https://api.anthropic.com",
  model: "claude-sonnet-4-5",
  vision: true,
};

/** @param {string} text */
const agentOf = (text) => {
  const r = parseConfig(text);
  expect(r.errors).toEqual([]);
  return /** @type {any} */ (r.config).agent;
};

describe("addAgentProviderText", () => {
  test("setup's provider becomes [agent] default in a missing file", () => {
    const r = addAgentProviderText(null, ollama, { makeDefault: true });
    if (!("text" in r)) throw new Error(r.error);
    expect(r.name).toBe("ollama");
    expect(r.text.startsWith(formatConfigTemplate())).toBe(true);
    const agent = agentOf(r.text);
    expect(agent.default).toBe("ollama");
    expect(agent.providers).toEqual([ollama]);
  });

  test("keeps every other line of the file", () => {
    const text =
      'schema = 2\n# mine\n[search]\ndefault = "DuckDuckGo" # kept\n\n[mcp]\nenabled = true\n';
    const r = addAgentProviderText(text, anthropic, { makeDefault: true });
    if (!("text" in r)) throw new Error(r.error);
    expect(r.text.startsWith(text)).toBe(true);
    const agent = agentOf(r.text);
    expect(agent.default).toBe("anthropic");
    expect(agent.providers).toEqual([anthropic]);
  });

  test("sets default inside an [agent] table the file has", () => {
    const text = "schema = 2\n[agent]\nmax_steps = 50 # mine\n\n[mcp]\nenabled = true\n";
    const r = addAgentProviderText(text, ollama, { makeDefault: true });
    if (!("text" in r)) throw new Error(r.error);
    expect(r.text).toContain("max_steps = 50 # mine\n");
    const agent = agentOf(r.text);
    expect(agent.default).toBe("ollama");
    expect(agent.maxSteps).toBe(50);
    expect(agent.providers).toEqual([ollama]);
  });

  test("adds a provider without changing the default", () => {
    const first = addAgentProviderText(null, ollama, { makeDefault: true });
    if (!("text" in first)) throw new Error(first.error);
    const r = addAgentProviderText(first.text, anthropic, { makeDefault: false });
    if (!("text" in r)) throw new Error(r.error);
    const agent = agentOf(r.text);
    expect(agent.default).toBe("ollama");
    expect(agent.providers).toEqual([ollama, anthropic]);
  });

  test("a provider the file has already is not added again", () => {
    const first = addAgentProviderText(null, ollama, { makeDefault: false });
    if (!("text" in first)) throw new Error(first.error);
    const r = addAgentProviderText(first.text, { ...ollama, name: "other" }, { makeDefault: true });
    if (!("text" in r)) throw new Error(r.error);
    expect(r.name).toBe("ollama");
    const agent = agentOf(r.text);
    expect(agent.providers).toEqual([ollama]);
    expect(agent.default).toBe("ollama");
  });

  test("a taken name gets a number", () => {
    const first = addAgentProviderText(null, ollama, { makeDefault: false });
    if (!("text" in first)) throw new Error(first.error);
    const r = addAgentProviderText(
      first.text,
      { ...ollama, model: "llama3.1:8b" },
      { makeDefault: false },
    );
    if (!("text" in r)) throw new Error(r.error);
    expect(r.name).toBe("ollama-2");
    expect(agentOf(r.text).providers.map((/** @type {any} */ p) => p.name)).toEqual([
      "ollama",
      "ollama-2",
    ]);
  });

  test("a model name with quotes, backslashes and DEL stays one string", () => {
    const model = 'a"b\\c\u007fd';
    const r = addAgentProviderText(null, { ...ollama, model }, { makeDefault: true });
    if (!("text" in r)) {
      // DEL is a control character, which [agent] refuses in a model name: nothing is written.
      expect(r.error).toMatch(/control characters/);
      return;
    }
    throw new Error("a control character was written");
  });

  test("never writes a key, and refuses a file that does not parse", () => {
    const r = addAgentProviderText(
      null,
      /** @type {any} */ ({ ...anthropic, key: "sk-secret", apiKey: "sk-secret" }),
      { makeDefault: true },
    );
    if (!("text" in r)) throw new Error(r.error);
    expect(r.text).not.toContain("sk-secret");
    expect(addAgentProviderText("[agent\n", ollama, { makeDefault: true })).toHaveProperty("error");
    expect(
      addAgentProviderText('schema = 2\n[agent]\ndefault = "nobody"\n', ollama, {
        makeDefault: true,
      }),
    ).toHaveProperty("error");
  });

  test("an [agent] table only implied by [[agent.providers]] gets its default", () => {
    const text =
      'schema = 2\n[[agent.providers]]\nname = "lm"\nkind = "openai"\n' +
      'endpoint = "http://127.0.0.1:1234/v1"\nmodel = "m"\n';
    const r = addAgentProviderText(text, ollama, { makeDefault: true });
    if (!("text" in r)) throw new Error(r.error);
    const agent = agentOf(r.text);
    expect(agent.default).toBe("ollama");
    expect(agent.providers.map((/** @type {any} */ p) => p.name)).toEqual(["lm", "ollama"]);
  });

  // docs/specs/builtin-agent-cli.md Behaviour 2, C4: an agent CLI setup picked goes in by name,
  // kind and cli only; its path is a pref, never in the file.
  test("an agent cli is written by name, kind, cli and model, never its path", () => {
    const claude = {
      name: "claude",
      kind: "cli",
      cli: "claude-code",
      endpoint: "",
      model: "",
      vision: false,
      maxMinutes: 30,
      path: "/home/u/.local/bin/claude",
    };
    const r = addAgentProviderText(null, claude, { makeDefault: true });
    if (!("text" in r)) throw new Error(r.error);
    expect(r.text).not.toContain("/home/u");
    expect(r.text).not.toContain("endpoint");
    expect(r.text.split("[[agent.providers]]")[1]).toBe(
      '\nname = "claude"\nkind = "cli"\ncli = "claude-code"\n',
    );
    const agent = agentOf(r.text);
    expect(agent.default).toBe("claude");
    expect(agent.providers).toEqual([
      {
        name: "claude",
        kind: "cli",
        cli: "claude-code",
        endpoint: "",
        model: "",
        vision: false,
        maxMinutes: 30,
      },
    ]);
    // The same CLI again is not added twice.
    const again = addAgentProviderText(r.text, claude, { makeDefault: false });
    if (!("text" in again)) throw new Error(again.error);
    expect(again.text).toBe(r.text);
  });
});
