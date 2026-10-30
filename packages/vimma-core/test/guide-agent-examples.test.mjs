// docs/guide.md, "Choosing a model for the agent chat" (#535): users copy these examples into
// config.toml, so each must parse as it stands. The guide is read here so that the docs and
// the parser cannot drift apart.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { parseConfig } from "../src/config.mjs";

const guide = readFileSync(new URL("../../../docs/guide.md", import.meta.url), "utf8");

/** The ```toml blocks of `text` that configure the agent. @param {string} text */
const agentExamples = (text) =>
  [...text.matchAll(/```toml\n([\s\S]*?)```/g)]
    .map((m) => /** @type {string} */ (m[1]))
    .filter((block) => /^\[\[?agent[\].]/m.test(block));

/** The guide's section under `heading`, up to the next heading of its level or above. */
function section(/** @type {string} */ heading) {
  const start = guide.indexOf(`\n${heading}\n`);
  if (start < 0) return "";
  const level = /** @type {string} */ (/^#+/.exec(heading))[0].length;
  const rest = guide.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return end < 0 ? rest : rest.slice(0, end);
}

describe("the guide's [agent] examples", () => {
  const all = agentExamples(guide);

  test("each parses as a whole config.toml, schema line included", () => {
    expect(all.length).toBeGreaterThan(0);
    for (const block of all) {
      expect(block.split("\n")[0], block).toBe("schema = 2");
      expect(parseConfig(block).errors, block).toEqual([]);
    }
  });

  test("the model section has one for each local server and each hosted kind", () => {
    const examples = agentExamples(section("#### Choosing a model for the agent chat"));
    const providers = examples.flatMap(
      (block) => /** @type {any} */ (parseConfig(block).config)?.agent.providers ?? [],
    );
    const at = (/** @type {string} */ origin) =>
      providers.filter((/** @type {any} */ p) => p.endpoint.startsWith(origin));
    // Ollama, LM Studio, the llama.cpp server and vLLM, on their default ports.
    for (const port of [11434, 1234, 8080, 8000]) {
      expect(at(`http://127.0.0.1:${port}/`), `port ${port}`).toHaveLength(1);
    }
    expect(at("https://api.anthropic.com")[0]?.kind).toBe("anthropic");
    const hosted = providers.filter(
      (/** @type {any} */ p) => p.kind === "openai" && p.endpoint.startsWith("https://"),
    );
    expect(hosted.length).toBeGreaterThan(0);
    // A key field is a config error: no example may show one.
    for (const block of examples) expect(block).not.toMatch(/^\s*(api_)?key\s*=/m);
  });
});
